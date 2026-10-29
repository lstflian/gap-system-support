'use strict';

const assert = require('assert/strict');
const http = require('http');
const {
    vscodeMock: vscode, createProfileState, createFixture, SecretStorage, Disposable, setConfiguration,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { toolOutput, credentialKey } = require('./helpers');
const { McpController } = require('../../../out/mcp');
const { McpCredentials } = require('../../../out/mcp/credentials');
const { createToolRegistry } = require('../../../out/lmtools/registry');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

async function definitions(providers) {
    const values = [];
    for (const provider of providers) {
        const list = await provider.provideMcpServerDefinitions();
        for (const definition of list) {
            values.push({ url: definition.uri.toString(), headers: definition.headers });
        }
    }
    return values;
}

function requestTools(definition) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'list_gap_books', arguments: {} },
        });
        const request = http.request(definition.url, {
            method: 'POST',
            headers: {
                ...definition.headers,
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'MCP-Protocol-Version': '2025-11-25',
            },
        }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
            response.on('error', reject);
        });
        request.on('error', reject);
        request.end(body);
    });
}

async function rejectsOldTools(definition) {
    try {
        return await requestTools(definition) !== 200;
    } catch (error) {
        assert(['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code), error.message);
        return true;
    }
}

async function callBooks(definition) {
    const client = new Client({ name: 'cross-window-test', version: '1.0.0' });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: { headers: definition.headers },
        }));
        return toolOutput(await client.callTool({ name: 'list_gap_books', arguments: {} }));
    } finally {
        await client.close();
    }
}

async function main() {
    const fixture = createFixture();
    const profile = createProfileState();
    const secrets = new SecretStorage();
    const windowA = { secrets, globalState: profile.createWindow(), globalStorageUri: fixture.context.globalStorageUri };
    const windowB = { secrets, globalState: profile.createWindow(), globalStorageUri: fixture.context.globalStorageUri };
    const providers = new Set();
    const controllers = [];
    const originalRegisterProvider = vscode.lm.registerMcpServerDefinitionProvider;
    const originalRegisterCommand = vscode.commands.registerCommand;
    let calls = 0;
    const sharedRegistry = createToolRegistry(fixture.context);
    const registry = {
        version: sharedRegistry.version,
        forEach(visitor) {
            sharedRegistry.forEach(entry => visitor({
                ...entry,
                tool: {
                    execute(...args) {
                        calls++;
                        return entry.tool.execute(...args);
                    },
                },
            }));
        },
    };
    try {
        // Each real window has a separate extension-host registration table.
        vscode.lm.registerMcpServerDefinitionProvider = (_name, provider) => {
            providers.add(provider);
            return new Disposable(() => providers.delete(provider));
        };
        vscode.commands.registerCommand = () => new Disposable();
        setConfiguration({ 'gap.mcp.enabled': true, 'gap.mcp.port': 0 });

        section('1. First-start race with independent Profile caches and shared secrets');
        const a = new McpController(registry, windowA);
        const b = new McpController(registry, windowB);
        controllers.push(a, b);
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        const initial = await definitions(providers);
        check('both independent windows publish a running HTTP service', 2, initial.length);
        for (const definition of initial) {
            check('each initial service executes the shared real tool', { books: ['Reference', 'Tutorial'] },
                await callBooks(definition));
        }
        await new McpCredentials(windowB).resetToken();
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        profile.flush();
        const profileKey = credentialKey(windowA);
        const profileAuthorization = `Bearer ${await secrets.get(profileKey)}`;
        const beforeOldRequest = calls;
        for (const obsolete of initial) {
            check('obsolete first-start credentials cannot execute after delayed reset state delivery', true,
                await rejectsOldTools(obsolete));
        }
        check('the namespace guard rejects before business logic executes', beforeOldRequest, calls);
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        const converged = await definitions(providers);
        check('both windows remain available after convergence', 2, converged.length);
        check('same Profile converges to one actual HTTP endpoint', 1,
            new Set(converged.map(definition => definition.url)).size);
        check('all published definitions use the authoritative Profile credential', true,
            converged.every(definition => definition.headers.Authorization === profileAuthorization));
        for (const definition of converged) {
            check('converged credentials work against both actual servers', { books: ['Reference', 'Tutorial'] },
                await callBooks(definition));
        }

        section('2. Reset notification arrives before the Profile cache update');
        await new McpCredentials(windowB).resetToken();
        const resetKey = credentialKey(windowB);
        const resetAuthorization = `Bearer ${await secrets.get(resetKey)}`;
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        profile.flush();
        const callsBeforeResetRequest = calls;
        for (const definition of converged) {
            check('old profile credentials cannot call either window after state delivery', true,
                await rejectsOldTools(definition));
        }
        check('no old-credential request reached shared execution', callsBeforeResetRequest, calls);
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        const resetDefinitions = await definitions(providers);
        check('both servers adopt reset credentials despite early secret notifications', true,
            resetDefinitions.length === 2
            && resetDefinitions.every(definition => definition.headers.Authorization === resetAuthorization));
        for (const definition of resetDefinitions) {
            const oldHeaders = { url: definition.url, headers: converged[0].headers };
            check('old tokens are explicitly unauthorized on the current endpoints', 401, await requestTools(oldHeaders));
            check('reset credentials still invoke the real shared tools', { books: ['Reference', 'Tutorial'] },
                await callBooks(definition));
        }

        section('3. Idle windows proactively notice Profile changes without another secret event');
        await new McpCredentials(windowB).resetToken();
        await Promise.all([a.whenIdle(), b.whenIdle()]);
        profile.flush();
        const newestAuthorization = `Bearer ${await secrets.get(credentialKey(windowA))}`;
        await new Promise(resolve => setTimeout(resolve, 1100));
        const latest = await definitions(providers);
        check('the Profile monitor refreshes otherwise idle windows', true,
            latest.length === 2 && latest.every(definition => definition.headers.Authorization === newestAuthorization));

        section('4. Another Profile never adopts this Profile credential');
        const otherProfile = createProfileState();
        const otherWindow = { secrets, globalState: otherProfile.createWindow(), globalStorageUri: fixture.context.globalStorageUri };
        const other = new McpController(registry, otherWindow);
        controllers.push(other);
        await other.whenIdle();
        otherProfile.flush();
        const otherAuthorization = `Bearer ${await secrets.get(credentialKey(otherWindow))}`;
        check('another Profile has its own token', false, otherAuthorization === newestAuthorization);
        const otherEndpoint = (await definitions(providers)).find(definition => definition.headers.Authorization === otherAuthorization);
        check('another Profile has a separate HTTP listener', false, otherEndpoint?.url === latest[0].url);
        await new McpCredentials(windowB).resetToken();
        profile.flush();
        await Promise.all(controllers.map(controller => controller.whenIdle()));
        const all = await definitions(providers);
        const otherDefinition = all.find(definition => definition.headers.Authorization === otherAuthorization);
        check('resetting this Profile leaves the other Profile available', true, !!otherDefinition);
        check('the other Profile token still invokes its tools', { books: ['Reference', 'Tutorial'] },
            await callBooks(otherDefinition));
        summary();
    } finally {
        await Promise.all(controllers.map(controller => controller.stop()));
        vscode.lm.registerMcpServerDefinitionProvider = originalRegisterProvider;
        vscode.commands.registerCommand = originalRegisterCommand;
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
