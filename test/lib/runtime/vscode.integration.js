'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { findGap } = require('../../../scripts/find-gap');

async function waitFor(predicate, message) {
    const deadline = Date.now() + 30000;
    while (!await predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

exports.run = async function run() {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const resultPath = process.env.GAP_RUNTIME_TEST_RESULT;
    const checks = [];
    const terminals = [];
    const opened = vscode.window.onDidOpenTerminal(terminal => terminals.push(terminal));
    try {
        assert(process.env.GAP_TEST_INSTALLATION && resultPath, 'Set GAP_TEST_INSTALLATION and GAP_RUNTIME_TEST_RESULT');
        assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'Use one isolated empty workspace');
        assert((await fs.readdir(workspace)).every(name => name === '.vscode'), 'Do not use a normal project');
        const found = await findGap({ directory: process.env.GAP_TEST_INSTALLATION });
        assert.equal(found.status, 'found');
        const installation = found.candidates[0];
        const config = vscode.workspace.getConfiguration('gap');
        await config.update('docPath', installation.docPath, vscode.ConfigurationTarget.Global);
        await config.update('pkgPath', installation.pkgPath, vscode.ConfigurationTarget.Global);
        await config.update('runMode', 'new', vscode.ConfigurationTarget.Global);
        await vscode.extensions.getExtension('flianlee.gap-system-support').activate();

        const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        const profiles = process.platform === 'win32' ? {
            'GAP test cmd': { path: process.env.ComSpec, args: ['/d'] },
            'GAP test PowerShell': {
                path: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                args: ['-NoLogo', '-NoProfile'],
            },
        } : { 'GAP test shell': { path: '/bin/sh' } };
        const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
        const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
        const baselinePath = inheritedPath.split(path.delimiter).filter(value => !/gap-/i.test(value)).join(path.delimiter);
        await terminalConfig.update(`env.${platform}`, { PATH: baselinePath }, vscode.ConfigurationTarget.Global);
        await terminalConfig.update(`profiles.${platform}`, profiles, vscode.ConfigurationTarget.Global);
        for (const [index, [name, profile]] of Object.entries(profiles).entries()) {
            await terminalConfig.update(`defaultProfile.${platform}`, name, vscode.ConfigurationTarget.Global);
            await waitFor(() => vscode.env.shell.toLowerCase() === profile.path.toLowerCase(), 'Default shell did not change');
            const marker = `run-${index}.txt`;
            const source = path.join(workspace, `run-${index}.g`);
            await fs.writeFile(source, `PrintTo("${marker}", "GAP_TERMINAL_OK");\nQUIT;\n`);
            const document = await vscode.workspace.openTextDocument(source);
            await vscode.window.showTextDocument(document);
            await vscode.commands.executeCommand('gap.runFile', document.uri);
            await waitFor(async () => (await fs.readdir(workspace)).includes(marker), `${name} did not run GAP`);
            assert.equal(await fs.readFile(path.join(workspace, marker), 'utf8'), 'GAP_TERMINAL_OK');
            const terminal = terminals.findLast(value => value.name === `GAP: run-${index}.g`);
            assert(terminal);
            const env = terminal.creationOptions.env;
            const launchedPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')[1];
            for (const directory of installation.environmentDirectories) assert(launchedPath.includes(directory));
            terminal.dispose();
            checks.push(`${name}: real Run GAP File with a terminal-local environment`);
        }
        assert.equal(await vscode.commands.executeCommand('gap.generateCompletionData'), true);
        const { getFunctionNames } = require('../../../out/editor/completion/dataManager');
        assert(getFunctionNames().size > 0);
        checks.push('real GAP completion data generation in a hidden terminal');
        const help = require('../../../out/help/helpData');
        const notifications = require('../../../out/shared/notify');
        const originalInfo = notifications.notifyInfo;
        const originalError = notifications.notifyError;
        const errors = [];
        const previousIndex = help.getHelpState();
        try {
            notifications.notifyInfo = (message, ...actions) => actions.includes('Rebuild')
                ? Promise.resolve('Rebuild') : originalInfo(message, ...actions);
            notifications.notifyError = message => { errors.push(message); return Promise.resolve(undefined); };
            await vscode.commands.executeCommand('gap.rebuildHelpIndex');
            assert.deepEqual(errors, []);
            assert.notEqual(help.getHelpState(), previousIndex);
            assert(help.getHelpState().entries.length > 0);
        } finally {
            notifications.notifyInfo = originalInfo;
            notifications.notifyError = originalError;
        }
        checks.push('real GAP help index export, conversion and reload in hidden terminals');
        await fs.writeFile(resultPath, JSON.stringify({ success: true, vscodeVersion: vscode.version, checks }, null, 2));
    } catch (error) {
        if (resultPath) await fs.writeFile(resultPath, JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
        throw error;
    } finally {
        opened.dispose();
        for (const terminal of terminals) terminal.dispose();
    }
};
