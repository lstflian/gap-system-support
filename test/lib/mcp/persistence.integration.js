'use strict';

// Run without --extensionTestsPath: VS Code deliberately uses in-memory storage in test mode.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const vscode = require('vscode');
const { toolOutput } = require('./helpers');

exports.run = async function run() {
    const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    let resultPath;
    let previousClipboard;
    let copiedClipboard;
    let client;
    const config = vscode.workspace.getConfiguration('gap');
    const originalEnabled = config.inspect('mcp.enabled')?.globalValue;
    try {
        assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Open one isolated empty test workspace');
        assert(fs.readdirSync(workspacePath).every(name =>
            name === '.vscode' || name === 'mcp-integration-result.json'), 'Do not run integration tests in a normal project');
        resultPath = path.join(workspacePath, 'mcp-integration-result.json');
        const extension = vscode.extensions.getExtension('flianlee.gap-system-support');
        assert(extension);
        await extension.activate();
        await config.update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
        previousClipboard = await vscode.env.clipboard.readText();
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        copiedClipboard = await vscode.env.clipboard.readText();
        const definition = JSON.parse(copiedClipboard);
        assert.equal(typeof definition.headers.Authorization, 'string');
        const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
        client = new Client({ name: 'persistent-token-integration', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: { headers: definition.headers },
        }));
        assert.equal((await client.listTools()).tools.length, 5);
        assert(toolOutput(await client.callTool({ name: 'list_gap_books', arguments: {} })).books.length > 0);
        fs.writeFileSync(resultPath, JSON.stringify({
            success: true,
            vscodeVersion: vscode.version,
            tokenFingerprint: createHash('sha256').update(definition.headers.Authorization).digest('hex'),
            shutdownUrl: definition.url,
        }, null, 2));
    } catch (error) {
        if (resultPath) {
            fs.writeFileSync(resultPath, JSON.stringify({ success: false, error: String(error) }, null, 2));
        }
        throw error;
    } finally {
        await client?.close();
        await config.update('mcp.enabled', originalEnabled, vscode.ConfigurationTarget.Global);
        if (copiedClipboard !== undefined && await vscode.env.clipboard.readText() === copiedClipboard) {
            await vscode.env.clipboard.writeText(previousClipboard);
        }
    }
};
