'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { findGap } = require('../../../scripts/find-gap');
const { vscodeMock: vscode, createFixture, setConfiguration } = require('../lmtools/mock-vscode');
const { GapInstallationController, gapEnvironment } = require('../../../out/runtime/installation');
const manifest = require('../../../package.json');

async function main() {
    const fixture = createFixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-discovery-'));
    const windows = path.join(root, 'GAP installation');
    const home = path.join(windows, 'runtime', 'opt', 'gap-test');
    const bin = path.join(windows, 'runtime', 'bin');
    let controller;
    try {
        await fs.mkdir(home, { recursive: true });
        await fs.writeFile(path.join(home, 'gap.exe'), '');
        await fs.writeFile(path.join(windows, 'gap.bat'), '@echo off\r\n');
        let result = await findGap({ directory: windows, platform: 'win32' });
        assert.equal(result.status, 'notFound');
        assert(result.issues.some(issue => issue.code === 'MISSING_RUNTIME_BIN'));
        await fs.mkdir(bin, { recursive: true });
        await fs.mkdir(path.join(home, 'doc'));
        await fs.mkdir(path.join(home, 'pkg'));
        result = await findGap({ directory: windows, platform: 'win32' });
        assert.equal(result.status, 'found');
        const selected = result.candidates[0];
        assert.deepEqual(selected.environmentDirectories, [home, bin]);
        assert.equal(selected.docPath, path.join(home, 'doc'));
        assert.equal((await findGap({ directory: home, platform: 'win32' })).status, 'found');
        assert.equal((await findGap({ directory: path.join(root, 'absent'), platform: 'win32' })).status, 'notFound');

        const other = path.join(windows, 'runtime', 'opt', 'gap-other');
        await fs.mkdir(other);
        await fs.writeFile(path.join(other, 'gap.exe'), '');
        assert.equal((await findGap({ directory: windows, platform: 'win32' })).status, 'ambiguous');

        const unix = path.join(root, 'unix');
        await fs.mkdir(path.join(unix, 'bin'), { recursive: true });
        await fs.writeFile(path.join(unix, 'bin', 'gap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        for (const platform of ['linux', 'darwin']) {
            const found = await findGap({ directory: unix, platform });
            assert.equal(found.status, 'found');
            assert.deepEqual(found.candidates[0].environmentDirectories, [path.join(unix, 'bin')]);
        }
        const before = JSON.stringify(process.env);
        const inherited = { ...process.env };
        const env = gapEnvironment(selected, inherited);
        const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')[1];
        assert(envPath.split(path.delimiter).includes(home));
        assert(envPath.split(path.delimiter).includes(bin));
        assert.equal(JSON.stringify(process.env), before);
        assert.equal(JSON.stringify(inherited) === before, true, 'the inherited environment must not be modified');
        assert(!Object.keys(manifest.contributes.configuration.properties).some(key => /installation|executable/i.test(key)));

        controller = new GapInstallationController(fixture.context);
        let scans = 0;
        const found = { status: 'found', candidates: [selected], issues: [] };
        controller.detect = async () => { scans++; return found; };
        const results = await Promise.all([controller.resolve(), controller.resolve()]);
        assert.equal(scans, 1);
        assert.equal(results[0].executable, selected.executable);
        await controller.resolve();
        assert.equal(scans, 1, 'cached valid installation is not scanned again');
        controller.dispose();
        controller = new GapInstallationController(fixture.context);
        controller.detect = async () => found;
        const helpPaths = { 'gap.docPath': vscode.workspace.getConfiguration('gap').get('docPath'),
            'gap.pkgPath': vscode.workspace.getConfiguration('gap').get('pkgPath') };
        const showInformation = vscode.window.showInformationMessage;
        let prompts = 0;
        try {
            setConfiguration({ 'gap.docPath': '', 'gap.pkgPath': '' });
            vscode.window.showInformationMessage = () => { prompts++; return new Promise(() => {}); };
            const unanswered = new Promise((_, reject) => setTimeout(() => reject(new Error('resolve waited for the doc/pkg prompt')), 2000));
            assert.equal((await Promise.race([controller.resolve(true), unanswered])).executable, selected.executable);
            assert.equal((await Promise.race([controller.resolve(true), unanswered])).executable, selected.executable);
            assert.equal(prompts, 1, 'an unanswered doc/pkg prompt is shown once and never blocks a GAP launch');
        } finally {
            vscode.window.showInformationMessage = showInformation;
            setConfiguration(helpPaths);
        }
        const saved = new Map();
        const state = {
            get: key => saved.get(key),
            update: async (key, value) => saved.set(key, value),
        };
        controller.dispose();
        controller = new GapInstallationController({ ...fixture.context, globalState: state });
        controller.detect = async directory => directory ? found : { status: 'notFound', candidates: [], issues: [] };
        let dialogs = 0;
        vscode.window.showWarningMessage = async (_message, action) => action;
        vscode.window.showOpenDialog = async () => { dialogs++; return [vscode.Uri.file(windows)]; };
        vscode.window.showInformationMessage = async () => undefined;
        assert.equal((await controller.resolve(true)).executable, selected.executable);
        assert.equal(dialogs, 1);
        assert.equal(saved.size, 1);
        assert([...saved.keys()][0].startsWith('gap.runtime.selectedDirectory.'));
        controller.dispose();
        controller = new GapInstallationController({ ...fixture.context, globalState: state });
        controller.detect = async directory => { assert.equal(directory, home); return found; };
        assert.equal((await controller.resolve()).executable, selected.executable, 'explicit choice survives reopening');
        controller.cache = undefined;
        controller.detect = async () => ({ status: 'notFound', candidates: [], issues: [] });
        await assert.rejects(() => controller.resolve(), error => error.code === 'GAP_INSTALLATION_REQUIRED');
        assert.equal(dialogs, 1, 'background tools never open a folder dialog');
        vscode.window.showWarningMessage = async () => undefined;
        await assert.rejects(() => controller.resolve(true), vscode.CancellationError);
        assert.equal(dialogs, 1, 'dismissing the notification never opens a folder dialog');
        assert.equal([...saved.values()][0], home);

        let warnings = 0;
        let choices = 0;
        vscode.window.showWarningMessage = async () => { warnings++; };
        vscode.window.showQuickPick = async () => { choices++; };
        controller.detect = async () => ({ status: 'ambiguous', candidates: [selected, { ...selected, directory: other }], issues: [] });
        await assert.rejects(() => controller.resolve(), error => error.code === 'GAP_INSTALLATION_REQUIRED');
        assert.equal(choices, 0, 'background ambiguity never opens a QuickPick');
        await vscode.commands.executeCommand('gap.detectInstallation');
        assert.equal(choices, 1);
        assert.equal(warnings, 0, 'canceling an installation choice is not a detection failure');
        assert.equal([...saved.values()][0], home);

        controller.detect = async () => ({ status: 'notFound', candidates: [], issues: [] });
        await vscode.commands.executeCommand('gap.selectInstallation');
        assert.equal([...saved.values()][0], home, 'an invalid selection preserves the last valid choice');
        assert.equal(warnings, 1);

        const dialogsBeforeDetectionError = dialogs;
        controller.detect = async directory => {
            if (!directory) throw new Error('GAP discovery failed');
            return found;
        };
        vscode.window.showWarningMessage = async (_message, action) => action;
        await vscode.commands.executeCommand('gap.detectInstallation');
        assert.equal(dialogs, dialogsBeforeDetectionError + 1, 'detection errors offer manual folder selection');

        controller.dispose();
        controller = new GapInstallationController({ ...fixture.context, globalState: state });
        controller.detect = async () => found;
        const customDoc = path.join(root, 'custom-doc');
        const informationMessages = [];
        setConfiguration({ 'gap.docPath': customDoc, 'gap.pkgPath': '' });
        vscode.window.showInformationMessage = async (message, action) => { informationMessages.push(message); return action; };
        await vscode.commands.executeCommand('gap.selectInstallation');
        assert(informationMessages.some(message => message.includes(selected.executable)),
            'successful installation selection reports the executable path');
        assert.equal(vscode.workspace.getConfiguration('gap').get('docPath'), customDoc);
        assert.equal(vscode.workspace.getConfiguration('gap').get('pkgPath'), selected.pkgPath);
        await controller.resolve();
        await fs.unlink(selected.executable);
        controller.detect = async () => ({ status: 'notFound', candidates: [], issues: [] });
        await assert.rejects(() => controller.resolve(), error => error.code === 'GAP_INSTALLATION_REQUIRED',
            'a removed launcher invalidates the cached selection');

        let release;
        const oldScan = new Promise(resolve => { release = resolve; });
        const replacement = { ...selected, directory: other, executable: path.join(other, 'gap.exe') };
        controller.detect = async directory => directory === home ? oldScan
            : { status: 'found', candidates: [replacement], issues: [] };
        const first = controller.resolve();
        await state.update([...saved.keys()][0], other);
        const second = controller.resolve();
        release(found);
        for (const resolved of await Promise.all([first, second])) {
            assert.equal(resolved.directory, other, 'a stale in-flight scan cannot replace a newer selection');
        }
        console.log('GAP discovery, platform layouts, environment isolation, persistence and noninteractive tools passed.');
    } finally {
        controller?.dispose();
        fixture.cleanup();
        await fs.rm(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
