'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createHash } = require('crypto');
const vscode = require('vscode');

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

function portIsOpen(value) {
    const url = new URL(value);
    return new Promise(resolve => {
        const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
        const finish = result => { socket.destroy(); resolve(result); };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(1000, () => finish(false));
    });
}

exports.run = async function run() {
    const checks = [];
    const config = vscode.workspace.getConfiguration('gap');
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    const resultPath = process.env.GAP_MCP_TEST_RESULT
        || (workspacePath && path.join(workspacePath, 'mcp-integration-result.json'));
    let client;
    let previousClipboard;
    let copiedClipboard;
    let shutdownUrl;
    try {
        assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Open one isolated empty test workspace');
        assert(fs.readdirSync(workspacePath).every(name =>
            name === '.vscode' || name === 'mcp-integration-result.json'), 'Do not run integration tests in a normal project');
        const extension = vscode.extensions.getExtension('flianlee.gap-system-support');
        assert(extension, 'Development extension must be installed');
        await extension.activate();
        const parser = require(path.join(root, 'out', 'parser', 'gapParser'));
        const nativeCount = () => vscode.lm.tools.filter(tool => names.has(tool.name)).length;
        await waitFor(() => nativeCount() === 4, 'Default native tools were not discovered');
        assert.equal(parser.isParserReady(), false);
        assert.equal(!!require.cache[require.resolve(path.join(root, 'out', 'mcp', 'server'))], false);
        checks.push('default native discovery and lightweight activation');

        const books = await vscode.lm.invokeTool('list_gap_books', {
            input: {}, toolInvocationToken: undefined,
        });
        assert(JSON.parse(books.content[0].value).books.length > 0);
        assert.equal(parser.isParserReady(), false);
        checks.push('native invocation without initializing the parser');

        await config.update('tools.enabled', false, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Workspace);
        assert.equal(vscode.workspace.getConfiguration('gap').get('tools.enabled'), false);
        await assert.rejects(() => vscode.lm.invokeTool('list_gap_books', {
            input: {}, toolInvocationToken: undefined,
        }));
        previousClipboard = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        assert.notEqual(copiedClipboard, previousClipboard, 'Copy command must publish fresh connection information');
        const definition = JSON.parse(copiedClipboard);
        assert.equal(definition.type, 'http');
        assert.equal(new URL(definition.url).hostname, '127.0.0.1');
        assert(definition.headers.Authorization.startsWith('Bearer '));
        assert.equal(parser.isParserReady(), false);
        const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
        client = new Client({ name: 'vscode-integration', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: { headers: definition.headers },
        }));
        assert.equal((await client.listTools()).tools.length, 4);
        assert((await client.callTool({ name: 'list_gap_books', arguments: {} })).structuredContent.books.length > 0);
        checks.push('workspace MCP enable and independent native disable');

        let mcpBooks;
        await waitFor(async () => {
            await vscode.commands.executeCommand('workbench.mcp.startServer',
                'flianlee.gap-system-support/GAP', { waitForLiveTools: true });
            mcpBooks = vscode.lm.tools.find(tool => !names.has(tool.name) && tool.name.includes('list_gap_books'));
            return !!mcpBooks;
        }, 'The workbench MCP client did not discover GAP tools');
        const workbenchBooks = await vscode.lm.invokeTool(mcpBooks.name, {
            input: {}, toolInvocationToken: undefined,
        });
        assert(JSON.parse(workbenchBooks.content[0].value).books.length > 0);
        checks.push('workbench-owned MCP startup, discovery and invocation with native tools disabled');

        await config.update('tools.enabled', true, vscode.ConfigurationTarget.Workspace);
        await waitFor(() => nativeCount() === 4, 'Native tools did not reappear');
        assert(JSON.parse((await vscode.lm.invokeTool('list_gap_books', {
            input: {}, toolInvocationToken: undefined,
        })).content[0].value).books.length > 0);
        assert.equal((await client.listTools()).tools.length, 4);
        checks.push('both tool surfaces enabled together');

        await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Workspace);
        await waitFor(async () => !await portIsOpen(definition.url), 'MCP port remained open after disabling');
        assert.equal(nativeCount(), 4);
        await client.close();
        client = undefined;
        checks.push('MCP disable closes the socket without disabling native tools');

        await config.update('tools.enabled', false, vscode.ConfigurationTarget.Workspace);
        await assert.rejects(() => vscode.lm.invokeTool('list_gap_books', {
            input: {}, toolInvocationToken: undefined,
        }));
        const document = await vscode.workspace.openTextDocument({ language: 'gap', content: 'x := ;\n' });
        await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0,
            'Ordinary GAP diagnostics failed with both tool surfaces disabled');
        assert.equal(parser.isParserReady(), true);
        checks.push('ordinary GAP diagnostics with both tool surfaces disabled');

        await config.update('tools.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', undefined, vscode.ConfigurationTarget.Workspace);
        await waitFor(() => nativeCount() === 4, 'Removing workspace override did not restore the default');
        assert(JSON.parse((await vscode.lm.invokeTool('list_gap_books', {
            input: {}, toolInvocationToken: undefined,
        })).content[0].value).books.length > 0);
        checks.push('removing workspace overrides restores defaults');
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const fixedPort = reservation.address().port;
        await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
        await config.update('mcp.port', fixedPort, vscode.ConfigurationTarget.Workspace);
        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        const fixed = JSON.parse(copiedClipboard);
        assert.equal(new URL(fixed.url).port, String(fixedPort));
        await config.update('mcp.enabled', false, vscode.ConfigurationTarget.Workspace);
        await waitFor(async () => !await portIsOpen(fixed.url), 'Fixed MCP port remained open after disabling');
        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Workspace);
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        const restarted = JSON.parse(copiedClipboard);
        assert.equal(restarted.url, fixed.url);
        assert.equal(restarted.headers.Authorization === fixed.headers.Authorization, true);
        checks.push('fixed URL and persistent token survive ordinary restarts');
        await vscode.commands.executeCommand('gap.resetMcpToken');
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        const reset = JSON.parse(copiedClipboard);
        assert.equal(reset.url, fixed.url);
        assert.equal(reset.headers.Authorization === restarted.headers.Authorization, false);
        const rejected = await fetch(reset.url, { headers: restarted.headers });
        await rejected.text();
        assert.equal(rejected.status, 401);
        const accepted = await fetch(reset.url, { headers: reset.headers });
        await accepted.text();
        assert.equal(accepted.status, 405);
        checks.push('explicit profile token reset rejects old credentials and publishes the replacement');
        shutdownUrl = reset.url;
        assert(await portIsOpen(shutdownUrl));
        checks.push('enabled MCP listener before extension-host shutdown');
        if (resultPath) {
            fs.writeFileSync(resultPath, JSON.stringify({
                success: true, vscodeVersion: vscode.version, checks, shutdownUrl,
                tokenFingerprint: createHash('sha256').update(reset.headers.Authorization).digest('hex'),
            }, null, 2));
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
        await client?.close();
        if (copiedClipboard !== undefined && await vscode.env.clipboard.readText() === copiedClipboard) {
            await vscode.env.clipboard.writeText(previousClipboard);
        }
    }
};
