'use strict';

const assert = require('assert/strict');
const http = require('http');
const { randomBytes } = require('crypto');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, grantTrust, CancellationTokenSource,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { createToolRegistry } = require('../../../out/lmtools/registry');
const { LmToolsController } = require('../../../out/lmtools');
const { McpController } = require('../../../out/mcp');
const { McpCredentials } = require('../../../out/mcp/credentials');
const parser = require('../../../out/parser/gapParser');
const manifest = require('../../../package.json');

function request(url, headers = {}, body, method = body === undefined ? 'GET' : 'POST') {
    return new Promise((resolve, reject) => {
        const requestHeaders = body === undefined || headers['Transfer-Encoding']
            ? headers : { 'Content-Length': Buffer.byteLength(body), ...headers };
        const req = http.request(url, { method, headers: requestHeaders }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function connect(definition, modern = false) {
    const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
    const client = new Client({ name: 'gap-tests', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
    await client.connect(new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: { headers: definition.headers },
    }));
    return client;
}

async function configuration(resolveDefinition = true) {
    const provider = state.providers.get('gap.mcp');
    assert(provider, 'MCP provider must be registered');
    const definitions = await provider.provideMcpServerDefinitions();
    assert.equal(definitions.length, 1);
    const token = new CancellationTokenSource();
    try {
        const definition = resolveDefinition
            ? await provider.resolveMcpServerDefinition(definitions[0], token.token) : definitions[0];
        assert(definition);
        return { url: definition.uri.toString(), headers: definition.headers, provider, definition };
    } finally {
        token.dispose();
    }
}

async function main() {
    const fixture = createFixture();
    const token = new CancellationTokenSource();
    const registry = createToolRegistry(fixture.context);
    const entries = new Map();
    registry.forEach(entry => entries.set(entry.metadata.name, entry));
    const native = new LmToolsController(registry);
    let mcp = new McpController(registry, fixture.context);
    const clients = [];
    const servers = [];
    try {
        section('1. Defaults and all four independent switch combinations');
        await mcp.whenIdle();
        check('native tools default to four', 4, state.tools.size);
        check('MCP has no default provider', 0, state.providers.size);
        check('disabled MCP does not load its SDK implementation', false,
            !!require.cache[require.resolve('../../../out/mcp/server')]);
        for (const [tools, enabled] of [[false, true], [true, true], [false, false], [true, false]]) {
            setConfiguration({ 'gap.tools.enabled': tools, 'gap.mcp.enabled': enabled });
            await mcp.whenIdle();
            check(`native count for ${tools}/${enabled}`, tools ? 4 : 0, state.tools.size);
            check(`MCP count for ${tools}/${enabled}`, enabled ? 1 : 0, state.providers.size);
            if (enabled) {
                const config = await configuration();
                const published = await configuration(false);
                check('published definition already includes authentication for Agent Host synchronization', true,
                    typeof published.headers.Authorization === 'string' && published.headers.Authorization.startsWith('Bearer '));
                const projected = JSON.parse(JSON.stringify({
                    type: 'http', transport: 'http', url: published.url, headers: published.headers,
                }));
                const projectedClient = await connect(projected);
                try {
                    check('serialized Agent Host configuration connects without resolveMcpServerDefinition', 4,
                        (await projectedClient.listTools()).tools.length);
                } finally {
                    await projectedClient.close();
                }
                const client = await connect(config);
                try {
                    check(`MCP tools remain available for native=${tools}`, 4, (await client.listTools()).tools.length);
                    check(`MCP book lookup for native=${tools}`, { books: ['Reference', 'Tutorial'] },
                        (await client.callTool({ name: 'list_gap_books', arguments: {} })).structuredContent);
                } finally {
                    await client.close();
                }
            }
        }

        section('2. Real legacy and modern clients reuse the same four implementations');
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        const config = await configuration();
        check('server label and tool-definition version are stable', ['GAP', manifest.version],
            [config.definition.label, config.definition.version]);
        const jsonHeaders = {
            ...config.headers,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
        };
        const initialized = await request(config.url, jsonHeaders, JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vscode-baseline', version: '1' } },
        }));
        assert.equal(initialized.status, 200);
        let initializedMessage;
        if (initialized.headers['content-type'].includes('application/json')) {
            initializedMessage = JSON.parse(initialized.body);
        } else {
            assert.match(initialized.headers['content-type'], /text\/event-stream/);
            const event = initialized.body.match(/^data: ?(.+)$/m);
            assert(event, 'initialize must return a JSON-RPC response');
            initializedMessage = JSON.parse(event[1]);
        }
        check('VS Code baseline protocol is negotiated exactly', '2025-11-25',
            initializedMessage.result.protocolVersion);
        for (const modern of [false, true]) {
            const client = await connect(config, modern);
            clients.push(client);
            check('client protocol era', modern ? 'modern' : 'legacy', client.getProtocolEra());
            const listed = (await client.listTools()).tools;
            for (const contribution of manifest.contributes.languageModelTools) {
                const tool = listed.find(value => value.name === contribution.name);
                check(`${modern ? 'modern' : 'legacy'} ${tool.name} schema`, contribution.inputSchema, tool.inputSchema);
                check(`${tool.name} MCP description`, contribution.modelDescription, tool.description);
                const expected = await entries.get(tool.name).tool.execute(fixture.inputs[tool.name], token.token);
                const result = await client.callTool({ name: tool.name, arguments: fixture.inputs[tool.name] });
                check(`${tool.name} structured MCP result`, expected, result.structuredContent);
                check(`${tool.name} text MCP result`, JSON.stringify(expected, null, 2), result.content[0].text);
            }
        }
        const client = clients[0];
        const malformed = await client.callTool({ name: 'search_gap_help', arguments: {} });
        check('schema failure is an error result', true, malformed.isError);
        const badBook = await client.callTool({ name: 'search_gap_help', arguments: { topic: 'Group', books: ['missing'] } });
        check('domain failure is an error result', true, badBook.isError);
        const missingFile = await client.callTool({ name: 'check_gap_syntax', arguments: { filePath: fixture.sourceFile + '.missing' } });
        check('file read failure is an error result', true, missingFile.isError);
        vscode.workspace.textDocuments = [{ uri: vscode.Uri.file(fixture.sourceFile), getText: () => 'x := ;\n' }];
        const invalidSyntax = await client.callTool({ name: 'check_gap_syntax', arguments: fixture.inputs.check_gap_syntax });
        check('syntax errors are findings, not execution errors', [false, false],
            [invalidSyntax.structuredContent.syntaxValid, invalidSyntax.isError === true]);
        vscode.workspace.textDocuments = [];
        setConfiguration({ 'gap.docPath': '' });
        check('missing help configuration is an error result', true,
            (await client.callTool({ name: 'search_gap_help', arguments: { topic: 'Group' } })).isError);
        setConfiguration({ 'gap.docPath': fixture.docPath });
        await assert.rejects(() => client.callTool({ name: 'unknown_tool', arguments: {} }));

        section('3. Authentication, DNS rebinding guards and body bounds');
        check('only loopback is advertised', '127.0.0.1', new URL(config.url).hostname);
        check('missing token is rejected', 401, (await request(config.url)).status);
        check('incorrect token is rejected', 401,
            (await request(config.url, { Authorization: 'Bearer invalid' })).status);
        check('foreign Host is rejected', 403,
            (await request(config.url, { ...config.headers, Host: 'attacker.example' })).status);
        check('foreign Origin is rejected', 403,
            (await request(config.url, { ...config.headers, Origin: 'https://attacker.example' })).status);
        check('null Origin is rejected', 403,
            (await request(config.url, { ...config.headers, Origin: 'null' })).status);
        check('unrelated route is not an MCP endpoint', 404,
            (await request(config.url + '/other', config.headers)).status);
        check('legacy GET is rejected without a session endpoint', 405, (await request(config.url, config.headers)).status);
        const ping = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
        check('payload exactly at the official 4 MiB limit is accepted', 200,
            (await request(config.url, jsonHeaders, ping.padEnd(4 * 1024 * 1024, ' '))).status);
        let oversizedRejected = false;
        try {
            oversizedRejected = (await request(config.url, jsonHeaders, Buffer.alloc(4 * 1024 * 1024 + 1, 32))).status === 413;
        } catch (error) {
            assert(['ECONNRESET', 'EPIPE'].includes(error.code), error.message);
            oversizedRejected = true;
        }
        check('payload over the official 4 MiB limit is rejected', true, oversizedRejected);
        check('an oversized upload does not stop the server', 200, (await request(config.url, jsonHeaders, ping)).status);

        section('4. Disabling revokes old handles and closes the listening socket');
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        const copied = JSON.parse(state.clipboard);
        check('connection command copies only the current server definition', ['http', config.url],
            [copied.type, copied.url]);
        check('copied authorization matches the running service', true, config.headers.Authorization === copied.headers.Authorization);
        const showInformationMessage = vscode.window.showInformationMessage;
        try {
            vscode.window.showInformationMessage = () => Promise.reject(new vscode.CancellationError());
            await vscode.commands.executeCommand('gap.copyMcpConfiguration');
            await new Promise(resolve => setImmediate(resolve));
            check('dismissed notification does not fail a completed clipboard write', true,
                JSON.parse(state.clipboard).headers.Authorization === config.headers.Authorization);
        } finally {
            vscode.window.showInformationMessage = showInformationMessage;
        }
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        check('provider withdrawn', 0, state.providers.size);
        check('old provider no longer publishes a definition', [], await config.provider.provideMcpServerDefinitions());
        check('old definition cannot be resolved', undefined,
            await config.provider.resolveMcpServerDefinition(config.definition, token.token));
        await assert.rejects(() => request(config.url, config.headers));
        const clipboard = state.clipboard;
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        check('disabled copy command does not overwrite the clipboard', clipboard, state.clipboard);
        for (const client of clients.splice(0)) await client.close();
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        const restarted = await configuration();
        check('restarting preserves the saved profile token', true, restarted.headers.Authorization === config.headers.Authorization);
        check('previously configured credentials remain authorized', 405, (await request(restarted.url, config.headers)).status);

        section('5. Workspace overrides, trust and idempotent updates');
        setConfiguration({ 'gap.mcp.enabled': false }, 'user');
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        check('workspace true overrides user false', 1, state.providers.size);
        setConfiguration({ 'gap.mcp.enabled': undefined });
        await mcp.whenIdle();
        check('removing workspace override restores user false', 0, state.providers.size);
        setConfiguration({ 'gap.mcp.enabled': true }, 'user');
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        check('workspace false overrides user true', 0, state.providers.size);
        vscode.workspace.isTrusted = false;
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        check('untrusted workspace cannot publish MCP even when enabled', 0, state.providers.size);
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        check('untrusted copy command explains trust requirement', true, state.messages.at(-1).message.includes('trusted'));
        grantTrust();
        await mcp.whenIdle();
        check('granting trust automatically starts enabled MCP', 1, state.providers.size);
        const count = state.providerRegistrations;
        setConfiguration({ 'gap.mcp.enabled': true });
        setConfiguration({ 'gap.tools.enabled': false });
        await mcp.whenIdle();
        check('duplicate events and native toggle do not restart MCP', count, state.providerRegistrations);
        setConfiguration({ 'gap.mcp.enabled': false });
        setConfiguration({ 'gap.mcp.enabled': true });
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        check('last rapid toggle wins', 0, state.providers.size);

        section('6. Concurrent server instances isolate ports and credentials');
        const { startMcpServer } = require('../../../out/mcp/server');
        const unexpected = error => { throw error; };
        const actualCreateServer = http.createServer;
        const addresses = [];
        let a;
        let b;
        try {
            http.createServer = (...args) => {
                const server = actualCreateServer(...args);
                server.once('listening', () => addresses.push(server.address().address));
                return server;
            };
            a = await startMcpServer(registry, () => true, unexpected, randomBytes(32).toString('hex'));
            servers.push(a);
            b = await startMcpServer(registry, () => true, unexpected, randomBytes(32).toString('hex'));
            servers.push(b);
        } finally {
            http.createServer = actualCreateServer;
        }
        check('actual HTTP sockets bind only to loopback', ['127.0.0.1', '127.0.0.1'], addresses);
        check('concurrent instances have distinct endpoints', false, a.url === b.url);
        check('concurrent instances have distinct tokens', false, a.authorization === b.authorization);
        check('one window token cannot authorize another window', 401,
            (await request(a.url, { Authorization: b.authorization })).status);
        await Promise.all(servers.splice(0).map(server => server.close()));

        section('7. Shutdown cancels pending legacy and modern tool calls');
        for (const modern of [false, true]) {
            let started;
            let cancelled = false;
            const entered = new Promise(resolve => { started = resolve; });
            const waiting = await startMcpServer({
                version: 'test',
                forEach(visitor) {
                    visitor({
                        metadata: {
                            name: 'wait', displayName: 'Wait', modelDescription: 'Wait for cancellation.',
                            inputSchema: { type: 'object', properties: {} },
                        },
                        tool: {
                            execute: (_input, invocationToken) => new Promise((_resolve, reject) => {
                                invocationToken.onCancellationRequested(() => {
                                    cancelled = true;
                                    reject(new vscode.CancellationError());
                                });
                                started();
                            }),
                        },
                    });
                },
            }, () => true, unexpected, randomBytes(32).toString('hex'));
            servers.push(waiting);
            const waitingClient = await connect({ url: waiting.url, headers: { Authorization: waiting.authorization } }, modern);
            clients.push(waitingClient);
            const outcome = waitingClient.callTool({ name: 'wait', arguments: {} })
                .then(result => ({ result }), error => ({ error }));
            await entered;
            await waiting.close();
            const completed = await outcome;
            check(`${modern ? 'modern' : 'legacy'} shutdown cancels the shared execution`, true, cancelled);
            check('cancelled call cannot report success', true, !!completed.error || completed.result.isError === true);
            await waitingClient.close();
            clients.pop();
            servers.pop();
        }

        section('8. Startup failure is explicit and native tools remain usable');
        setConfiguration({ 'gap.tools.enabled': true });
        const originalCreateServer = http.createServer;
        const originalConsoleError = console.error;
        const errors = [];
        try {
            console.error = (...args) => errors.push(args);
            http.createServer = (...args) => {
                const server = originalCreateServer(...args);
                server.listen = () => {
                    queueMicrotask(() => server.emit('error', new Error('test bind failure')));
                    return server;
                };
                return server;
            };
            setConfiguration({ 'gap.mcp.enabled': true });
            await mcp.whenIdle();
        } finally {
            http.createServer = originalCreateServer;
            console.error = originalConsoleError;
        }
        check('failed startup publishes no provider', 0, state.providers.size);
        check('failed startup is reported to the user', true, state.messages.at(-1).message.includes('test bind failure'));
        check('failed startup is logged', true, errors.some(args => args.some(value => value?.message === 'test bind failure')));
        check('native tools are not unregistered by MCP failure', 4, state.tools.size);
        check('native tool still executes after MCP failure', { books: ['Reference', 'Tutorial'] },
            JSON.parse((await state.tools.get('list_gap_books').invoke({ input: {} }, token.token)).content[0].value));
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();

        section('9. Disabling while listen is pending cannot publish a late server');
        let enteredListen;
        let releaseListen;
        let candidate;
        const listenEntered = new Promise(resolve => { enteredListen = resolve; });
        const listenGate = new Promise(resolve => { releaseListen = resolve; });
        try {
            http.createServer = (...args) => {
                const server = originalCreateServer(...args);
                const listen = server.listen.bind(server);
                server.listen = (...listenArgs) => {
                    enteredListen();
                    listenGate.then(() => listen(...listenArgs));
                    return server;
                };
                server.once('listening', () => {
                    candidate = `http://127.0.0.1:${server.address().port}/mcp`;
                });
                return server;
            };
            setConfiguration({ 'gap.mcp.enabled': true });
            await listenEntered;
            setConfiguration({ 'gap.mcp.enabled': false });
            releaseListen();
            await mcp.whenIdle();
        } finally {
            releaseListen();
            http.createServer = originalCreateServer;
        }
        check('cancelled startup never registers a provider', 0, state.providers.size);
        assert(candidate);
        await assert.rejects(() => request(candidate));
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        check('startup can recover after a cancelled attempt', 1, state.providers.size);

        section('10. Optional fixed ports, live reconfiguration and explicit conflicts');
        check('port defaults to operating-system allocation', 0,
            manifest.contributes.configuration.properties['gap.mcp.port'].default);
        check('port setting supports workspace overrides', 'window',
            manifest.contributes.configuration.properties['gap.mcp.port'].scope);
        for (const invalid of [-1, 65536, 1.5, '54336']) {
            await assert.rejects(() => startMcpServer(registry, () => true, unexpected, randomBytes(32).toString('hex'), invalid), /must be an integer/);
        }
        await assert.rejects(() => startMcpServer(registry, () => true, unexpected, ''), /saved MCP credential is invalid/);
        const occupied = http.createServer();
        await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
        const fixedPort = occupied.address().port;
        try {
            const logged = [];
            try {
                console.error = (...args) => logged.push(args);
                setConfiguration({ 'gap.mcp.port': fixedPort });
                await mcp.whenIdle();
            } finally {
                console.error = originalConsoleError;
            }
            check('port conflict does not silently choose another port', 0, state.providers.size);
            check('port conflict has an actionable notification', true,
                state.messages.at(-1).message.includes(`MCP port ${fixedPort} is already in use`));
            check('port conflict is logged explicitly', true, logged.length > 0);
            check('port conflict leaves native tools available', 4, state.tools.size);
        } finally {
            await new Promise((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
        }
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        const fixed = await configuration(false);
        check('configured fixed port is used exactly', String(fixedPort), new URL(fixed.url).port);
        const fixedClient = await connect(fixed);
        try {
            check('external clients can use the published fixed-port configuration', 4, (await fixedClient.listTools()).tools.length);
        } finally {
            await fixedClient.close();
        }
        const duplicatePort = http.createServer();
        let conflict;
        try {
            await new Promise((resolve, reject) => {
                duplicatePort.once('error', reject);
                duplicatePort.listen(fixedPort, '127.0.0.1', resolve);
            });
        } catch (error) {
            conflict = error.code;
        } finally {
            if (duplicatePort.listening) await new Promise(resolve => duplicatePort.close(resolve));
        }
        check('fixed listener owns its port and prevents accidental duplication', 'EADDRINUSE', conflict);
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();
        const fixedRestarted = await configuration(false);
        check('fixed URL survives a service restart', fixed.url, fixedRestarted.url);
        check('fixed-port restart preserves the profile credentials', true, fixed.headers.Authorization === fixedRestarted.headers.Authorization);
        check('existing fixed-port client credentials remain valid', 405, (await request(fixedRestarted.url, fixed.headers)).status);
        const providerCount = state.providerRegistrations;
        setConfiguration({ 'gap.mcp.port': fixedPort });
        await mcp.whenIdle();
        check('unchanged fixed port does not restart the server', providerCount, state.providerRegistrations);
        setConfiguration({ 'gap.mcp.port': 0 });
        await mcp.whenIdle();
        const automatic = await configuration(false);
        check('live port changes preserve the saved credentials', true,
            automatic.headers.Authorization === fixedRestarted.headers.Authorization);
        if (automatic.url === fixed.url) {
            check('automatic allocation can reuse the saved credentials', 405,
                (await request(fixed.url, fixedRestarted.headers)).status);
        } else {
            await assert.rejects(() => request(fixed.url, fixedRestarted.headers));
        }
        const automaticClient = await connect(automatic);
        try {
            check('returning to automatic allocation remains connectable', 4, (await automaticClient.listTools()).tools.length);
        } finally {
            await automaticClient.close();
        }

        section('11. Profile credentials survive controller recreation and reset explicitly');
        check('all ordinary restarts wrote the credential only once', 1, fixture.context.secrets.writeCalls);
        await mcp.stop();
        mcp = new McpController(registry, fixture.context);
        await mcp.whenIdle();
        const reopened = await configuration(false);
        check('recreating the controller preserves persisted credentials', true,
            reopened.headers.Authorization === automatic.headers.Authorization);
        const copiedBeforeReset = JSON.parse(JSON.stringify(reopened));
        await vscode.commands.executeCommand('gap.resetMcpToken');
        await mcp.whenIdle();
        const reset = await configuration(false);
        check('reset command replaces the profile credential', false,
            reset.headers.Authorization === reopened.headers.Authorization);
        check('reset immediately rejects previously copied credentials', 401,
            (await request(reset.url, copiedBeforeReset.headers)).status);
        check('the replacement credential is accepted', 405, (await request(reset.url, reset.headers)).status);
        check('reset leaves native tools available', 4, state.tools.size);
        await new McpCredentials(fixture.context).resetToken();
        await mcp.whenIdle();
        const peerReset = await configuration(false);
        check('a secret change from another window refreshes this controller', false,
            peerReset.headers.Authorization === reset.headers.Authorization);
        check('peer reset invalidates the previously active credential', 401,
            (await request(peerReset.url, reset.headers)).status);
        const profileCredentialKey = fixture.context.globalState.get('gap.mcp.tokenKey');
        const registrationsBeforeDuplicate = state.providerRegistrations;
        await fixture.context.secrets.store(profileCredentialKey, await fixture.context.secrets.get(profileCredentialKey));
        await mcp.whenIdle();
        check('duplicate secret notifications do not restart an unchanged server', registrationsBeforeDuplicate,
            state.providerRegistrations);
        const writesBeforeUnrelated = fixture.context.secrets.writeCalls;
        const registrationsBeforeUnrelated = state.providerRegistrations;
        await fixture.context.secrets.store('unrelated', 'test value');
        await mcp.whenIdle();
        check('unrelated secret changes do not restart MCP', registrationsBeforeUnrelated, state.providerRegistrations);
        setConfiguration({ 'gap.mcp.enabled': false });
        await mcp.whenIdle();
        await vscode.commands.executeCommand('gap.resetMcpToken');
        check('reset while disabled does not enable MCP', 0, state.providers.size);
        check('disabled reset still persists a new credential', writesBeforeUnrelated + 2, fixture.context.secrets.writeCalls);
        setConfiguration({ 'gap.mcp.enabled': true });
        await mcp.whenIdle();

        section('12. Credential storage failures never downgrade authentication');
        const current = await configuration(false);
        const originalStore = fixture.context.secrets.store;
        const loggedStorageErrors = [];
        try {
            console.error = (...args) => loggedStorageErrors.push(args);
            fixture.context.secrets.store = async () => { throw new Error('test persistent token store failure'); };
            await vscode.commands.executeCommand('gap.resetMcpToken');
        } finally {
            fixture.context.secrets.store = originalStore;
            console.error = originalConsoleError;
        }
        check('failed reset explains the storage failure', true,
            state.messages.at(-1).message.includes('test persistent token store failure'));
        check('failed reset is logged explicitly', true, loggedStorageErrors.length > 0);
        const afterFailure = await configuration(false);
        check('failed reset retains the existing valid service', true,
            afterFailure.headers.Authorization === current.headers.Authorization);
        check('failed reset does not bypass authentication', 401, (await request(afterFailure.url)).status);
        const credentialKey = fixture.context.globalState.get('gap.mcp.tokenKey');
        assert(credentialKey);
        try {
            console.error = (...args) => loggedStorageErrors.push(args);
            await fixture.context.secrets.store(credentialKey, 'invalid saved token');
            await mcp.whenIdle();
        } finally {
            console.error = originalConsoleError;
        }
        check('an invalid stored credential withdraws the service', 0, state.providers.size);
        check('invalid credentials produce an actionable error', true,
            state.messages.at(-1).message.includes('Reset MCP Access Token'));
        await vscode.commands.executeCommand('gap.resetMcpToken');
        await mcp.whenIdle();
        const recovered = await configuration(false);
        check('reset recovers an invalid credential without disabling native tools', [1, 4],
            [state.providers.size, state.tools.size]);
        const recoveredClient = await connect(recovered);
        try {
            check('recovered persistent credentials authorize actual tools', 4,
                (await recoveredClient.listTools()).tools.length);
        } finally {
            await recoveredClient.close();
        }
        summary();
    } finally {
        for (const client of clients) await client.close();
        await Promise.all(servers.map(server => server.close()));
        native.dispose();
        await mcp.stop();
        token.dispose();
        parser.disposeAll();
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
