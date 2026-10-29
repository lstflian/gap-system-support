'use strict';
const path = require('node:path');
const {
    vscodeMock: vscode, createFixture, setConfiguration,
} = require('../lmtools/mock-vscode');
const { createToolRegistry } = require('../../../out/lmtools/registry');
const { McpController } = require('../../../out/mcp');

(async () => {
    const fixture = createFixture();
    const controllerContext = { ...fixture.context, globalStorageUri: vscode.Uri.file(process.env.GAP_SHARED_STORAGE) };
    const folder = { uri: vscode.Uri.file(process.env.GAP_ROOT), name: path.basename(process.env.GAP_ROOT), index: 0 };
    const file = process.env.GAP_SOURCE;
    vscode.workspace.workspaceFolders = [folder];
    vscode.workspace.getWorkspaceFolder = uri => {
        const source = path.resolve(uri.fsPath).toLowerCase();
        const root = path.resolve(folder.uri.fsPath).toLowerCase();
        return source === root || source.startsWith(root + path.sep) ? folder : undefined;
    };
    const key = 'gap.mcp.token.test';
    await fixture.context.globalState.update('gap.mcp.instanceId', process.env.GAP_INSTANCE);
    await fixture.context.globalState.update('gap.mcp.tokenKey', key);
    await fixture.context.secrets.store(key, process.env.GAP_TOKEN);
    setConfiguration({ 'gap.mcp.enabled': true, 'gap.mcp.port': Number(process.env.GAP_PORT) });
    const registry = createToolRegistry(fixture.context);
    const controller = new McpController(registry, controllerContext);
    await controller.whenIdle();
    const provider = require('../lmtools/mock-vscode').state.providers.get('gap.mcp');
    if (!provider) throw new Error('Missing MCP provider');
    const [definition] = provider.provideMcpServerDefinitions();
    process.send({ type: 'ready', url: definition.uri.toString(), headers: definition.headers,
        brokerPid: controller.server.pid, window: process.env.GAP_WINDOW });
    process.on('message', async message => {
        if (message.type === 'dirty') {
            vscode.workspace.textDocuments = [{ uri: vscode.Uri.file(file), isDirty: true,
                async save() {
                    require('node:fs').writeFileSync(file, 'Print("saved from window ' + process.env.GAP_WINDOW + '");\n');
                    this.isDirty = false;
                    return true;
                },
            }];
            process.send({ type: 'dirty' });
        }
        if (message.type === 'close') {
            await controller.stop();
            await registry.close();
            fixture.cleanup();
            process.send({ type: 'closed' });
            process.exit(0);
        }
    });
})().catch(error => { process.send?.({ type: 'error', error: error.stack }); process.exitCode = 1; });
