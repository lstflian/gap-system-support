'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const {
    vscodeMock: vscode, createFixture, createContext, Disposable, setConfiguration,
} = require('../lmtools/mock-vscode');
const { McpController } = require('../../../out/mcp');
const { McpCredentials } = require('../../../out/mcp/credentials');
const { createToolRegistry } = require('../../../out/lmtools/registry');

function status(url, authorization) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { headers: { Authorization: authorization } }, response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('MCP authentication check timed out')));
    });
}

async function main() {
    const fixture = createFixture();
    const secrets = fixture.context.secrets;
    const oldKey = 'gap.mcp.token.snapshot-test';
    const oldToken = randomBytes(32).toString('hex');
    await secrets.store(oldKey, oldToken);
    const initial = [
        ['gap.mcp.instanceId', randomUUID()],
        ['gap.mcp.tokenKey', { key: oldKey, revision: 0 }],
    ];
    const cacheA = new Map(initial);
    const cacheB = new Map(initial);
    const windowA = createContext(fixture.context.globalStorageUri.fsPath, secrets, cacheA);
    const windowB = createContext(fixture.context.globalStorageUri.fsPath, secrets, cacheB);
    const providers = new Set();
    const originalProvider = vscode.lm.registerMcpServerDefinitionProvider;
    const originalCommand = vscode.commands.registerCommand;
    const originalConsoleError = console.error;
    const registry = createToolRegistry(fixture.context);
    const controllers = [];
    try {
        vscode.lm.registerMcpServerDefinitionProvider = (_id, provider) => {
            providers.add(provider);
            return new Disposable(() => providers.delete(provider));
        };
        vscode.commands.registerCommand = () => new Disposable();
        setConfiguration({ 'gap.mcp.enabled': true, 'gap.mcp.port': 0 });
        const a = new McpController(registry, windowA);
        const b = new McpController(registry, windowB);
        controllers.push(a, b);
        await Promise.all(controllers.map(controller => controller.whenIdle()));
        await new McpCredentials(windowB).resetToken();
        await b.whenIdle();
        const current = await new McpCredentials(windowB).getCredential();
        const definition = () => [...providers].flatMap(provider => provider.provideMcpServerDefinitions())
            .find(value => value.headers.Authorization === `Bearer ${current.token}`);
        assert(definition(), 'the resetting window must publish its current credentials');
        const url = definition().uri.toString();
        assert.equal(await status(url, `Bearer ${oldToken}`), 401);

        // Restore A's old cache to simulate delayed Profile delivery after its secret was deleted.
        cacheA.set('gap.mcp.tokenKey', { key: oldKey, revision: 0 });
        cacheA.set('gap.mcp.credentialRevision', current.revision);
        const stale = await new McpCredentials(windowA).getCredential();
        assert.deepEqual(stale, current, 'a stale window adopts the replacement with its matching revision');
        assert.equal(await secrets.get(oldKey), undefined, 'a stale read must not recreate the retired secret');
        secrets.changed.fire({ key: current.key });
        await a.whenIdle();
        console.error = originalConsoleError;
        assert.equal(await status(url, `Bearer ${oldToken}`), 401, 'a delayed window must not restore the old token');
        assert.equal(await status(url, `Bearer ${current.token}`), 405, 'the current token remains authenticated');

        cacheA.set('gap.mcp.tokenKey', cacheB.get('gap.mcp.tokenKey'));
        await a.whenIdle();
        const definitions = [...providers].flatMap(provider => provider.provideMcpServerDefinitions());
        assert.equal(definitions.length, 2, 'the stale window recovers after the atomic Profile snapshot arrives');
        assert(definitions.every(value => value.headers.Authorization === `Bearer ${current.token}`));
        assert.deepEqual(await secrets.keys(), [current.key], 'reset and delayed reads leave one stored token');
        console.log('A deleted reset token stays absent and unauthorized; delayed windows adopt the replacement.');
    } finally {
        console.error = originalConsoleError;
        await Promise.all(controllers.map(controller => controller.stop()));
        await registry.close();
        vscode.lm.registerMcpServerDefinitionProvider = originalProvider;
        vscode.commands.registerCommand = originalCommand;
        fixture.cleanup();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
