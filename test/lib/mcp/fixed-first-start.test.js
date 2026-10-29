'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const {
    vscodeMock: vscode, createProfileState, createFixture, SecretStorage, Disposable, setConfiguration,
} = require('../lmtools/mock-vscode');
const { McpController } = require('../../../out/mcp');
const { createToolRegistry } = require('../../../out/lmtools/registry');

async function main() {
    const fixture = createFixture();
    const profile = createProfileState();
    const secrets = new SecretStorage();
    const contexts = [0, 1].map(() => ({
        globalState: profile.createWindow(), secrets, globalStorageUri: fixture.context.globalStorageUri,
    }));
    const providers = new Set();
    const originalProvider = vscode.lm.registerMcpServerDefinitionProvider;
    const originalCommand = vscode.commands.registerCommand;
    const controllers = [];
    const registry = createToolRegistry(fixture.context);
    const reservation = net.createServer();
    try {
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        vscode.lm.registerMcpServerDefinitionProvider = (_id, provider) => {
            providers.add(provider);
            return new Disposable(() => providers.delete(provider));
        };
        vscode.commands.registerCommand = () => new Disposable();
        setConfiguration({ 'gap.mcp.enabled': true, 'gap.mcp.port': port });
        controllers.push(...contexts.map(context => new McpController(registry, context)));
        await Promise.all(controllers.map(controller => controller.whenIdle()));
        profile.flush();
        const deadline = Date.now() + 12000;
        let urls = [];
        while (Date.now() < deadline) {
            await Promise.all(controllers.map(controller => controller.whenIdle()));
            urls = [...providers].flatMap(provider => provider.provideMcpServerDefinitions().map(item => item.uri.toString()));
            if (urls.length === 2 && new Set(urls).size === 1) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(urls.length, 2, 'both windows must recover after first-start Profile state converges: ' + JSON.stringify({
            ids: contexts.map(context => context.globalState.get('gap.mcp.instanceId')),
            attempted: controllers.map(controller => controller.attemptedInstanceId), urls,
            pending: controllers.map(controller => controller.credentialRefreshPending),
        }));
        assert.equal(new Set(urls).size, 1, 'a fixed port must be shared after convergence');
        assert.equal(new URL(urls[0]).port, String(port));
        console.log('Two cold-start windows converge on the same fixed port.');
    } finally {
        await Promise.all(controllers.map(controller => controller.stop()));
        vscode.lm.registerMcpServerDefinitionProvider = originalProvider;
        vscode.commands.registerCommand = originalCommand;
        await registry.close();
        fixture.cleanup();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
