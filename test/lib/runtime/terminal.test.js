'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { vscodeMock: vscode, createFixture, setConfiguration, state } = require('../lmtools/mock-vscode');
const { initializeGapInstallation } = require('../../../out/runtime/installation');
const { prepareGapTerminal } = require('../../../out/runtime/terminal');
const { registerGapCommands } = require('../../../out/editor/commands');
const { languageHost } = require('../../../out/editor/languageHost');

async function main() {
    const fixture = createFixture();
    const installation = initializeGapInstallation(fixture.context);
    const terminals = [];
    const closed = new vscode.EventEmitter();
    const environmentBefore = JSON.stringify(process.env);
    let selected = 'first';
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    installation.resolve = async () => ({
        directory: path.join(fixture.root, selected),
        executable: path.join(fixture.root, selected, process.platform === 'win32' ? 'gap.exe' : 'gap'),
        environmentDirectories: [path.join(fixture.root, selected), path.join(fixture.root, 'runtime-bin')],
    });
    const document = {
        uri: vscode.Uri.file(path.join(fixture.root, 'test.g')),
        fileName: 'test.g', languageId: 'gap', isUntitled: false, isDirty: false,
    };
    let workspaceRoot = vscode.Uri.file(fixture.root);
    vscode.workspace.getWorkspaceFolder = uri => uri.scheme === 'file' ? { uri: workspaceRoot } : undefined;
    assert.equal(languageHost.workspaceRoot(vscode.Uri.parse('untitled:Untitled-1')), null,
        'the host adapter must preserve non-file URI schemes');
    assert.equal(languageHost.workspaceRoot(document.uri), fixture.root);
    vscode.window.activeTextEditor = { document };
    vscode.window.onDidCloseTerminal = closed.event;
    vscode.window.createTerminal = options => {
        const terminal = { options, commands: [], disposed: false, show() {},
            sendText(command) { this.commands.push(command); },
            dispose() { this.disposed = true; closed.fire(this); } };
        terminals.push(terminal);
        return terminal;
    };
    try {
        await fixture.context.globalState.update('gap.flags', ['-q']);
        registerGapCommands(fixture.context, async () => true);
        const run = () => vscode.commands.executeCommand('gap.runFile');
        await run();
        await run();
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0].commands.length, 2);
        assert(terminals[0].commands[0].includes('-q'));
        const envPath = env => Object.entries(env).find(([key]) => key.toLowerCase() === 'path')[1];
        assert(envPath(terminals[0].options.env).includes(path.join(fixture.root, 'runtime-bin')));

        selected = 'second';
        await run();
        assert.equal(terminals.length, 2);
        assert.equal(terminals[0].disposed, false, 'changing GAP must not terminate an earlier job');
        assert(terminals[1].commands[0].includes('second'));

        const customPath = path.join(fixture.root, 'custom-path');
        setConfiguration({ [`terminal.integrated.env.${platform}`]: { PATH: customPath } });
        await run();
        assert.equal(terminals.length, 3, 'a changed terminal environment must not reuse the old terminal');
        assert(envPath(terminals[2].options.env).includes(customPath));
        const profilePath = path.join(fixture.root, 'profile-path');
        setConfiguration({
            [`terminal.integrated.defaultProfile.${platform}`]: 'test-profile',
            [`terminal.integrated.profiles.${platform}`]: { 'test-profile': { env: { PATH: profilePath } } },
        });
        const profileLaunch = await prepareGapTerminal();
        assert(envPath(profileLaunch.env).includes(profilePath));
        assert(!envPath(profileLaunch.env).includes(customPath), 'profile PATH retains its precedence');
        await run();
        assert.equal(terminals.length, 4);
        workspaceRoot = vscode.Uri.file(path.join(fixture.root, 'other-workspace'));
        await run();
        assert.equal(terminals.length, 4);
        assert(terminals[3].commands.at(-2).includes('other-workspace'));

        terminals[3].dispose();
        await run();
        assert.equal(terminals.length, 5);
        setConfiguration({ 'gap.runMode': 'new' });
        await run();
        await run();
        assert.equal(terminals.length, 7);
        const originalShell = vscode.env.shell;
        vscode.env.shell = '/usr/local/bin/pwsh';
        assert((await prepareGapTerminal()).command.startsWith('& "'), 'pwsh needs the call operator on every platform');
        vscode.env.shell = '/usr/local/bin/notpwsh';
        assert((await prepareGapTerminal()).command.startsWith('"'));
        vscode.env.shell = originalShell;
        if (process.platform === 'win32') {
            vscode.env.shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            assert((await prepareGapTerminal()).command.startsWith('& "'));
            vscode.env.shell = 'C:\\Windows\\System32\\wsl.exe';
            assert.deepEqual(await prepareGapTerminal(), {
                command: 'gap', env: { NoDefaultCurrentDirectoryInExePath: '1' }, key: vscode.env.shell,
            });
        }
        assert.equal(state.messages.filter(value => value.type === 'error').length, 0);
        assert.equal(JSON.stringify(process.env) === environmentBefore, true);
        console.log('Run command reuse, replacement, cwd, profile environments, shell quoting and URI preservation passed.');
    } finally {
        installation.dispose();
        for (const disposable of fixture.context.subscriptions) disposable.dispose();
        closed.dispose();
        fixture.cleanup();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
