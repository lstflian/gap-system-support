'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    vscodeMock: vscode, state, setConfiguration, createContext, createFixture, grantTrust, shellChanged, foldersChanged,
    SecretStorage,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { McpController } = require('../../../out/tools/mcp');
const manifest = require('../../../package.json');

function installationStub(directory) {
    const changed = new vscode.EventEmitter();
    return {
        directory,
        selectedDirectory() { return this.directory; },
        onDidChangeSelection: changed.event,
        select(value) { this.directory = value; changed.fire(); },
    };
}

async function main() {
    const fixture = createFixture();
    const installation = installationStub(fixture.bin);
    const controllers = [];
    try {
        section('1. Provider registration and defaults');
        const controller = new McpController(fixture.context, installation);
        controllers.push(controller);
        await controller.whenIdle();
        const provider = state.providers.get('gap.mcp');
        check('one provider uses the contributed id', [1, true], [state.providers.size, !!provider]);
        check('contributed provider id', 'gap.mcp', manifest.contributes.mcpServerDefinitionProviders[0].id);
        check('MCP is disabled by default', false, manifest.contributes.configuration.properties['gap.mcp.enabled'].default);
        check('no definition while disabled', [], await provider.provideMcpServerDefinitions());
        check('no port or token settings remain', [false, false], [
            'gap.mcp.port' in manifest.contributes.configuration.properties,
            manifest.contributes.commands.some(command => command.command === 'gap.resetMcpToken'),
        ]);
        check('no HTTP adapter dependency remains', false, '@modelcontextprotocol/node' in manifest.dependencies);

        section('2. Enabling publishes one complete stdio definition');
        let changes = 0;
        provider.onDidChangeMcpServerDefinitions(() => changes++);
        setConfiguration({ 'gap.mcp.enabled': true }, 'user');
        check('enabling notifies VS Code', 1, changes);
        let [definition] = await provider.provideMcpServerDefinitions();
        check('stdio definition', [true, 'GAP', process.execPath], [
            definition instanceof vscode.McpStdioServerDefinition, definition.label, definition.command]);
        const script = path.resolve(__dirname, '..', '..', '..', 'out', 'tools', 'mcp', 'stdio.js');
        check('runs the compiled stdio server script', [script], definition.args);
        check('the script exists', true, fs.existsSync(definition.args[0]));
        check('version follows the extension', manifest.version, definition.version);
        check('Electron runs as Node.js without inherited Node options', ['1', null],
            [definition.env.ELECTRON_RUN_AS_NODE, definition.env.NODE_OPTIONS]);
        check('window settings are passed to the server', [
            fixture.context.globalStorageUri.fsPath, fixture.docPath, fixture.pkgPath, 'prefix', vscode.env.shell, '', fixture.bin, '[]',
        ], [
            definition.env.GAP_MCP_STORAGE, definition.env.GAP_MCP_DOC_PATH, definition.env.GAP_MCP_PKG_PATH,
            definition.env.GAP_MCP_SEARCH_MODE, definition.env.GAP_MCP_SHELL, definition.env.GAP_MCP_TERMINAL_ROOT,
            definition.env.GAP_MCP_GAP_DIRECTORY, definition.env.GAP_MCP_WORKSPACE_ROOTS,
        ]);
        check('no port, URL or credential is published', false,
            /port|url|token|authorization/i.test(JSON.stringify(Object.keys(definition.env))));
        check('resolve keeps the provided definition', definition, await provider.resolveMcpServerDefinition(definition));

        section('3. Workspace overrides, user fallback and workspace trust');
        setConfiguration({ 'gap.mcp.enabled': false }, 'user');
        changes = 0;
        setConfiguration({ 'gap.mcp.enabled': true }, 'workspace');
        check('workspace enabling overrides user disabling and notifies', [1, 1],
            [changes, (await provider.provideMcpServerDefinitions()).length]);
        setConfiguration({ 'gap.mcp.enabled': true }, 'user');
        setConfiguration({ 'gap.mcp.enabled': false }, 'workspace');
        check('workspace disabling overrides user enabling and withdraws stale definitions', [3, [], undefined],
            [changes, await provider.provideMcpServerDefinitions(), await provider.resolveMcpServerDefinition(definition)]);
        setConfiguration({ 'gap.mcp.enabled': undefined }, 'workspace');
        check('removing a workspace override restores the user value and notifies', [4, 1],
            [changes, (await provider.provideMcpServerDefinitions()).length]);
        setConfiguration({ 'gap.mcp.enabled': undefined }, 'user');
        check('removing both overrides restores the disabled default', [5, []],
            [changes, await provider.provideMcpServerDefinitions()]);
        setConfiguration({ 'gap.mcp.enabled': true }, 'workspace');
        check('workspace enabling overrides the disabled default', [6, 1],
            [changes, (await provider.provideMcpServerDefinitions()).length]);
        setConfiguration({ 'gap.mcp.enabled': undefined }, 'workspace');
        check('removing the workspace override restores the disabled default', [7, []],
            [changes, await provider.provideMcpServerDefinitions()]);
        setConfiguration({ 'gap.mcp.enabled': true }, 'workspace');
        vscode.workspace.isTrusted = false;
        check('untrusted workspaces provide nothing', [], await provider.provideMcpServerDefinitions());
        check('untrusted workspaces never start the server', undefined, await provider.resolveMcpServerDefinition(definition));
        changes = 0;
        grantTrust();
        check('granting trust notifies VS Code', 1, changes);
        check('trusted workspaces provide the server again', 1, (await provider.provideMcpServerDefinitions()).length);

        section('4. Setting, folder, shell and installation changes update the definition');
        changes = 0;
        setConfiguration({ 'gap.diagnostics': false });
        check('unrelated settings do not notify', 0, changes);
        setConfiguration({ 'gap.searchMode': 'substring' });
        [definition] = await provider.provideMcpServerDefinitions();
        check('search mode change notifies and is passed on', [1, 'substring'], [changes, definition.env.GAP_MCP_SEARCH_MODE]);
        setConfiguration({ 'gap.searchMode': undefined });
        const folder = path.join(fixture.root, 'workspace');
        vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folder), name: 'workspace', index: 0 },
            { uri: vscode.Uri.parse('vscode-vfs://github/remote'), name: 'remote', index: 1 }];
        foldersChanged.fire({ added: [], removed: [] });
        [definition] = await provider.provideMcpServerDefinitions();
        check('workspace folders notify and only local folders are passed', [3, JSON.stringify([folder])],
            [changes, definition.env.GAP_MCP_WORKSPACE_ROOTS]);
        vscode.workspace.workspaceFolders = [];
        const shell = vscode.env.shell;
        vscode.env.shell = process.platform === 'win32' ? 'C:\\Windows\\System32\\wsl.exe' : '/bin/bash';
        shellChanged.fire(vscode.env.shell);
        [definition] = await provider.provideMcpServerDefinitions();
        check('shell changes notify and are passed on', [4, vscode.env.shell], [changes, definition.env.GAP_MCP_SHELL]);
        vscode.env.shell = shell;
        installation.select(path.join(fixture.root, 'other-gap'));
        [definition] = await provider.provideMcpServerDefinitions();
        check('choosing another GAP installation notifies', [5, path.join(fixture.root, 'other-gap')],
            [changes, definition.env.GAP_MCP_GAP_DIRECTORY]);
        installation.select(fixture.bin);
        setConfiguration({ 'gap.mcp.enabled': false });
        check('disabling notifies and withdraws the server', [7, []], [changes, await provider.provideMcpServerDefinitions()]);

        section('5. Copying the configuration for other MCP clients');
        state.clipboard = '';
        state.messages.length = 0;
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        const copied = JSON.parse(state.clipboard);
        check('copied stdio configuration', ['stdio', process.execPath, [script]], [copied.type, copied.command, copied.args]);
        check('copied environment contains only strings', true,
            Object.values(copied.env).every(value => typeof value === 'string') && copied.env.ELECTRON_RUN_AS_NODE === '1');
        check('copy works without enabling VS Code MCP and reports success', ['info'], state.messages.map(message => message.type));
        vscode.workspace.isTrusted = false;
        state.clipboard = '';
        state.messages.length = 0;
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        check('untrusted workspaces do not copy', ['', ['warning']], [state.clipboard, state.messages.map(message => message.type)]);
        grantTrust();

        section('6. Disposal unregisters everything');
        controller.dispose();
        controllers.pop();
        check('provider and command are unregistered', [false, false],
            [state.providers.has('gap.mcp'), state.commands.has('gap.copyMcpConfiguration')]);
        changes = 0;
        setConfiguration({ 'gap.mcp.enabled': true });
        check('listeners are removed', 0, changes);
        setConfiguration({ 'gap.mcp.enabled': undefined });
        setConfiguration({ 'gap.mcp.enabled': undefined }, 'user');
        section('7. Former HTTP service state is removed');
        const storage = path.join(fixture.root, 'legacy-storage');
        fs.mkdirSync(storage, { recursive: true });
        const secrets = new SecretStorage();
        const values = new Map([
            ['gap.mcp.tokenKey', { key: 'gap.mcp.token.a', revision: 1 }], ['gap.mcp.credentialRevision', 1],
            ['gap.mcp.instanceId', 'instance'], ['gap.mcp.scopeNotice', true], ['gap.flags', ['-q']],
        ]);
        for (const key of ['gap.mcp.token.a', 'gap.mcp.token.a.2.0b5f8c43-7f3c-4a43-9b8e-0f3f3d6b1c11.pending', 'other.secret']) {
            await secrets.store(key, 'value');
        }
        const hash = createHash('sha256').update(fs.realpathSync(storage) + '\0instance').digest('hex').slice(0, 32);
        const broker = process.platform === 'win32' ? path.join(storage, 'mcp', hash)
            : path.join(os.tmpdir(), `gap-mcp-${process.getuid?.() ?? 'user'}-${hash}`);
        fs.mkdirSync(broker, { recursive: true });
        fs.writeFileSync(path.join(broker, 'control.key'), 'secret');
        const legacy = new McpController(createContext(storage, secrets, values), installation);
        controllers.push(legacy);
        await legacy.whenIdle();
        check('old Profile state is removed and unrelated state is kept', [['gap.flags', ['-q']]],
            [...values].filter(([, value]) => value !== undefined));
        check('old access tokens are removed and other secrets are kept', ['other.secret'], await secrets.keys());
        check('old broker folder is removed', false, fs.existsSync(broker));
        legacy.dispose();
        controllers.pop();

        summary();
    } finally {
        for (const controller of controllers) controller.dispose();
        vscode.workspace.isTrusted = true;
        vscode.workspace.workspaceFolders = [];
        fixture.cleanup();
    }
    assert.equal(state.providers.size, 0);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
