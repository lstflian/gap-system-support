'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { connect, toolOutput } = require('./helpers');

const root = path.resolve(__dirname, '..', '..', '..');
const manifest = require(path.join(root, 'package.json'));
const names = new Set(manifest.contributes.languageModelTools.map(tool => tool.name));

async function waitFor(predicate, message) {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

exports.run = async function run() {
    const checks = [];
    const config = vscode.workspace.getConfiguration('gap');
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    const resultPath = process.env.GAP_MCP_TEST_RESULT
        || (workspacePath && path.join(workspacePath, 'mcp-integration-result.json'));
    let session;
    let previousClipboard;
    let copiedClipboard;
    const originalMcpEnabled = config.inspect('mcp.enabled')?.globalValue;
    const originalWorkspaceMcpEnabled = config.inspect('mcp.enabled')?.workspaceValue;
    const mcpBooks = () => vscode.lm.tools.find(tool => !names.has(tool.name) && tool.name.includes('gapListBooks'));
    try {
        assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Open one isolated empty test workspace');
        assert(fs.readdirSync(workspacePath).every(name =>
            name === '.vscode' || name === 'mcp-integration-result.json'), 'Do not run integration tests in a normal project');
        const extension = vscode.extensions.getExtension('flianlee.gap-system-support');
        assert(extension, 'Development extension must be installed');
        await extension.activate();
        const parser = require(path.join(root, 'out', 'language', 'parser', 'gapParser'));
        const nativeCount = () => vscode.lm.tools.filter(tool => names.has(tool.name)).length;
        await waitFor(() => nativeCount() === 5, 'Default native tools were not discovered');
        assert.equal(parser.isParserReady(), false);
        assert.equal(Object.keys(require.cache).some(key => key.includes('@modelcontextprotocol')), false,
            'The extension host must not load the MCP SDK');
        checks.push('default native discovery and lightweight activation');

        const books = await vscode.lm.invokeTool('gapListBooks', {
            input: {}, toolInvocationToken: undefined,
        });
        assert(JSON.parse(books.content[0].value).books.length > 0);
        assert.equal(parser.isParserReady(), false);
        checks.push('native invocation without initializing the parser');

        await config.update('tools.enabled', false, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Global);
        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('gap').get('tools.enabled'), false);
        assert.equal(vscode.workspace.getConfiguration('gap').get('mcp.enabled'), true);
        await assert.rejects(() => vscode.lm.invokeTool('gapListBooks', {
            input: {}, toolInvocationToken: undefined,
        }));
        previousClipboard = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        const definition = JSON.parse(copiedClipboard);
        assert.equal(definition.type, 'stdio');
        assert.equal(definition.command, process.execPath);
        assert(fs.existsSync(definition.args[0]));
        assert.equal(/port|url|token|authorization/i.test(Object.keys(definition.env).join(',')), false);
        session = await connect(definition);
        assert.deepEqual((await session.client.listTools()).tools.map(tool => tool.name), [...names]);
        assert(toolOutput(await session.client.callTool({ name: 'gapListBooks', arguments: {} })).books.length > 0);
        await session.client.close();
        session = undefined;
        checks.push('the copied stdio configuration starts the editor-bundled Node.js server outside the workbench');

        let workbenchBooks;
        await waitFor(async () => {
            await vscode.commands.executeCommand('workbench.mcp.startServer',
                'flianlee.gap-system-support/GAP', { waitForLiveTools: true });
            workbenchBooks = mcpBooks();
            return !!workbenchBooks;
        }, 'The workbench MCP client did not discover GAP tools');
        const result = await vscode.lm.invokeTool(workbenchBooks.name, {
            input: {}, toolInvocationToken: undefined,
        });
        assert(JSON.parse(result.content[0].value).books.length > 0);
        checks.push('workspace MCP enablement overrides user disabling: workbench startup, discovery and invocation with native tools disabled');

        await config.update('tools.enabled', true, vscode.ConfigurationTarget.Workspace);
        await waitFor(() => nativeCount() === 5, 'Native tools did not reappear');
        assert(JSON.parse((await vscode.lm.invokeTool('gapListBooks', {
            input: {}, toolInvocationToken: undefined,
        })).content[0].value).books.length > 0);
        assert(mcpBooks());
        checks.push('both tool surfaces enabled together');

        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
        await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('gap').get('mcp.enabled'), false);
        await waitFor(() => !mcpBooks(), 'Disabling MCP did not withdraw the workbench server');
        assert.equal(nativeCount(), 5);
        checks.push('workspace MCP disabling overrides user enabling without disabling native tools');

        await config.update('mcp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('gap').get('mcp.enabled'), true);
        await waitFor(async () => {
            await vscode.commands.executeCommand('workbench.mcp.startServer',
                'flianlee.gap-system-support/GAP', { waitForLiveTools: true });
            return !!mcpBooks();
        }, 'Removing the workspace override did not restore user-enabled MCP');
        assert.equal(nativeCount(), 5);
        checks.push('removing the workspace override restores user-enabled MCP without changing native tools');
        await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Global);
        await waitFor(() => !mcpBooks(), 'User-level disabling did not withdraw the workbench server');

        await config.update('tools.enabled', false, vscode.ConfigurationTarget.Workspace);
        await assert.rejects(() => vscode.lm.invokeTool('gapListBooks', {
            input: {}, toolInvocationToken: undefined,
        }));
        const document = await vscode.workspace.openTextDocument({ language: 'gap', content: 'x := ;\n' });
        await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0,
            'Ordinary GAP diagnostics failed with both tool surfaces disabled');
        assert.equal(parser.isParserReady(), true);
        checks.push('ordinary GAP diagnostics with both tool surfaces disabled');

        await config.update('tools.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', undefined, vscode.ConfigurationTarget.Global);
        assert.equal(vscode.workspace.getConfiguration('gap').get('mcp.enabled'), false);
        await waitFor(() => nativeCount() === 5, 'Removing workspace override did not restore the default');
        checks.push('removing native workspace and MCP user overrides restores defaults');
        if (resultPath) {
            fs.writeFileSync(resultPath, JSON.stringify({ success: true, vscodeVersion: vscode.version, checks }, null, 2));
        }
        console.log(`GAP VS Code integration: ${checks.length} checks passed`);
    } catch (error) {
        if (resultPath) {
            fs.writeFileSync(resultPath, JSON.stringify({
                success: false, vscodeVersion: vscode.version, checks, error: String(error), stack: error.stack,
            }, null, 2));
        }
        throw error;
    } finally {
        await session?.client.close();
        await config.update('mcp.enabled', originalWorkspaceMcpEnabled, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', originalMcpEnabled, vscode.ConfigurationTarget.Global);
        if (copiedClipboard !== undefined && await vscode.env.clipboard.readText() === copiedClipboard) {
            await vscode.env.clipboard.writeText(previousClipboard);
        }
    }
};
