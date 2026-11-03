'use strict';

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, CancellationTokenSource,
} = require('./mock-vscode');
const { RunFileTool } = require('../../../out/tools/runFileTool');
const { nativeGapLaunch, shellGapLaunch } = require('../../../out/runtime/gapRun');
const { toRuntimePath, toShellPath } = require('../../../out/path');
const { LmToolsController } = require('../../../out/tools/native');
const { createWindowToolHost, createWindowToolRegistry } = require('../../../out/tools/native/host');

async function waitFor(predicate, message) {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function log(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function record(file, running = false) {
    const metadata = () => log(file).split('\n').find(line => line.startsWith('{"args":'));
    await waitFor(() => {
        const line = metadata();
        return line?.endsWith('}') && (!running || alive(JSON.parse(line).pid));
    }, `No live output at ${file}`);
    return JSON.parse(metadata());
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ')) {
            return false;
        }
        return true;
    } catch (error) {
        if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
        throw error;
    }
}

async function stopped(info) {
    await waitFor(() => !alive(info.pid) && (!info.childPid || !alive(info.childPid)), 'Invocation left a running process');
}

function source(file, settings = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# runner: ${JSON.stringify(settings)}\nx := 1;\n`);
}

async function main() {
    const fixture = createFixture();
    const host = createWindowToolHost(fixture.context);
    const tool = new RunFileTool(host);
    const registry = createWindowToolRegistry(fixture.context);
    const token = new CancellationTokenSource();
    const inputs = fixture.inputs.gapRunFile;
    const originalFolder = vscode.workspace.getWorkspaceFolder;
    const controllers = [];
    try {
        console.log('1. Exact result, overwrite, streaming-sized output, saved buffer and workspace cwd');
        const folderA = { uri: vscode.Uri.file(path.join(fixture.root, 'workspace-a')), name: 'a', index: 0 };
        const folderB = { uri: vscode.Uri.file(path.join(fixture.root, 'workspace-b')), name: 'b', index: 1 };
        const file = path.join(folderB.uri.fsPath, 'nested', 'a space \u6d4b\u8bd5.g');
        const output = path.join(fixture.root, 'new parent', 'nested', 'output.txt');
        source(file);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'old log must disappear\n');
        let saved = 0;
        vscode.workspace.workspaceFolders = [folderA, folderB];
        vscode.workspace.getWorkspaceFolder = uri => [folderA, folderB].find(folder =>
            uri.fsPath.startsWith(folder.uri.fsPath + path.sep));
        vscode.workspace.textDocuments = [{
            uri: vscode.Uri.file(file), isDirty: true,
            async save() {
                saved++;
                source(file, { bytes: 3 * 1024 * 1024, exitCode: 23, stderr: 'GAP internal error\n' });
                return true;
            },
        }];
        await fixture.context.globalState.update('gap.flags', ['-q', '-T']);
        setConfiguration({ 'gap.runMode': 'reuse' });
        const result = await tool.execute({ filePath: file, outputPath: output }, token.token);
        assert.deepEqual(result, { completed: true });
        assert.equal(saved, 1);
        const info = await record(output);
        assert.deepEqual(info.args, ['-q', '--nointeract', '*stdin*', file]);
        assert.equal(info.cwd.toLowerCase(), folderB.uri.fsPath.toLowerCase());
        assert(log(output).includes('GAP internal error'));
        assert(log(output).includes('finished\n'));
        assert(!log(output).includes('old log must disappear'));
        assert(fs.statSync(output).size > 3 * 1024 * 1024);
        const preparation = tool.prepare({ filePath: file, outputPath: output });
        assert(preparation.confirmationMessages.message.includes(output));
        assert(preparation.confirmationMessages.message.includes(file));
        const overrideCwd = path.join(fixture.root, 'explicit cwd');
        fs.mkdirSync(overrideCwd);
        const overrideInput = { filePath: file, outputPath: output, cwd: overrideCwd };
        await tool.execute(overrideInput, token.token);
        assert.equal((await record(output)).cwd.toLowerCase(), overrideCwd.toLowerCase());
        assert(tool.prepare(overrideInput).confirmationMessages.message.includes(overrideCwd));
        const beforeInvalid = saved;
        const rejectedOutput = path.join(fixture.root, 'invalid-cwd-output.txt');
        for (const cwd of ['', '  ', null, 42, {}, 'relative', path.join(fixture.root, 'missing'), file]) {
            await assert.rejects(() => tool.execute({ filePath: file, outputPath: rejectedOutput, cwd }, token.token));
            assert.equal(saved, beforeInvalid, 'invalid cwd must not save the document');
            assert.equal(fs.existsSync(rejectedOutput), false, 'invalid cwd must not create the output');
        }
        vscode.workspace.textDocuments = [];
        vscode.workspace.getWorkspaceFolder = originalFolder;
        await tool.execute(inputs, token.token);
        assert.equal((await record(inputs.outputPath)).cwd.toLowerCase(), os.homedir().toLowerCase());
        await tool.execute({ ...inputs, cwd: overrideCwd }, token.token);
        assert.equal((await record(inputs.outputPath)).cwd.toLowerCase(), overrideCwd.toLowerCase());

        console.log('1a. Only GAP confirms startup; chunked markers are removed without losing output');
        const startupFile = path.join(fixture.root, 'startup.g');
        const startupOutput = path.join(fixture.root, 'startup.txt');
        for (const exitCode of [0, 127]) {
            source(startupFile, { startupExitCode: exitCode });
            await assert.rejects(() => tool.execute({
                filePath: startupFile, outputPath: startupOutput,
            }, token.token), /did not confirm startup/);
            assert(log(startupOutput).includes('launcher output before startup'));
            assert(log(startupOutput).includes('launcher failed before GAP started'));
        }
        for (const exitCode of [1, 126, 127]) {
            source(startupFile, { exitCode });
            assert.deepEqual(await tool.execute({
                filePath: startupFile, outputPath: startupOutput,
            }, token.token), { completed: true });
        }
        source(startupFile, { startupHang: true });
        const startupCancellation = new CancellationTokenSource();
        const waitingForStartup = tool.execute({
            filePath: startupFile, outputPath: startupOutput,
        }, startupCancellation.token);
        const startupRejected = assert.rejects(waitingForStartup, /Canceled/);
        const waitingProcess = await record(startupOutput, true);
        startupCancellation.cancel();
        await startupRejected;
        await stopped(waitingProcess);
        startupCancellation.dispose();
        source(startupFile, {
            splitReady: true, banner: 'banner \u6d4b\u8bd5\n',
            stdout: '\u6d4b\u8bd5 stdout without a final newline', stderr: '',
        });
        await tool.execute({ filePath: startupFile, outputPath: startupOutput }, token.token);
        assert(log(startupOutput).startsWith('banner \u6d4b\u8bd5\n'));
        assert(log(startupOutput).endsWith('\u6d4b\u8bd5 stdout without a final newlinefinished\n'));
        assert(!log(startupOutput).includes('GAP_RUN_READY_'));
        assert.equal(fs.readFileSync(startupFile, 'utf8').includes('GAP_RUN_READY_'), false);

        console.log('1b. Modified documents are saved through file aliases and rechecked after atomic save');
        const original = path.join(fixture.root, 'source-identities', 'original.g');
        const directoryAlias = path.join(fixture.root, 'source-junction');
        const hardlink = path.join(fixture.root, 'source-hardlink.g');
        source(original, { stdout: 'old disk content\n' });
        fs.symlinkSync(path.dirname(original), directoryAlias, process.platform === 'win32' ? 'junction' : 'dir');
        fs.linkSync(original, hardlink);
        const aliases = [path.join(directoryAlias, 'original.g'), hardlink];
        if (process.platform === 'win32') aliases.push(path.toNamespacedPath(original));
        for (const alias of aliases) {
            let aliasSaved = 0;
            const dirty = {
                uri: vscode.Uri.file(original), isDirty: true,
                async save() {
                    aliasSaved++;
                    source(original, { stdout: 'freshly saved document\n' });
                    return true;
                },
            };
            vscode.workspace.textDocuments = [
                { uri: vscode.Uri.file(path.join(fixture.root, 'deleted-open-file.g')), isDirty: true },
                { uri: vscode.Uri.file(alias), isDirty: false },
                dirty,
            ];
            await tool.execute({ filePath: alias, outputPath: startupOutput }, token.token);
            assert.equal(aliasSaved, 1);
            assert(log(startupOutput).includes('freshly saved document'));
            assert(!log(startupOutput).includes('old disk content'));
        }
        let atomicSaved = 0;
        const atomicDocument = {
            uri: vscode.Uri.file(original), isDirty: true,
            async save() {
                atomicSaved++;
                const replacement = path.join(path.dirname(original), 'replacement.g');
                source(replacement, { stdout: 'atomic saved content\n' });
                fs.renameSync(replacement, original);
                return true;
            },
        };
        vscode.workspace.textDocuments = [atomicDocument];
        fs.writeFileSync(startupOutput, 'do not start or truncate output');
        await assert.rejects(() => tool.execute({
            filePath: hardlink, outputPath: startupOutput,
        }, token.token), /no longer refers to the saved document/);
        assert.equal(atomicSaved, 1);
        assert.equal(log(startupOutput), 'do not start or truncate output');
        await tool.execute({ filePath: aliases[0], outputPath: startupOutput }, token.token);
        assert.equal(atomicSaved, 2);
        assert(log(startupOutput).includes('atomic saved content'));
        vscode.workspace.textDocuments = [{
            uri: vscode.Uri.file(aliases[0]), isDirty: true,
            async save() {
                source(original, { stdout: 'saved through the document alias\n' });
                return true;
            },
        }];
        await tool.execute({ filePath: original, outputPath: startupOutput }, token.token);
        assert(log(startupOutput).includes('saved through the document alias'));
        vscode.workspace.textDocuments[0].save = async () => false;
        fs.writeFileSync(startupOutput, 'failed alias save must not overwrite');
        await assert.rejects(() => tool.execute({
            filePath: original, outputPath: startupOutput,
        }, token.token), /Could not save/);
        assert.equal(log(startupOutput), 'failed alias save must not overwrite');
        vscode.workspace.textDocuments = [];

        console.log('2. Input/output validation, trust and source-file alias protection');
        for (const changes of [
            { filePath: 'relative.g' }, { outputPath: 'relative.txt' }, { filePath: '' },
            { filePath: null }, { outputPath: 2 }, { outputPath: output + '\0' },
        ]) {
            await assert.rejects(() => tool.execute({ ...inputs, ...changes }, token.token), /absolute file path/);
        }
        await assert.rejects(() => tool.execute({ ...inputs, filePath: fixture.root }, token.token), /readable file/);
        await assert.rejects(() => tool.execute({ ...inputs, filePath: path.join(fixture.root, 'missing.g') }, token.token), /ENOENT/);
        await assert.rejects(() => tool.execute({ ...inputs, outputPath: fixture.root }, token.token), /not a directory|not a directory or another special file/);
        const originalSource = fs.readFileSync(inputs.filePath, 'utf8');
        for (const target of [inputs.filePath, path.join(fixture.root, 'input-alias.g')]) {
            if (target !== inputs.filePath) fs.linkSync(inputs.filePath, target);
            await assert.rejects(() => tool.execute({ ...inputs, outputPath: target }, token.token), /source file/);
            assert.equal(fs.readFileSync(inputs.filePath, 'utf8'), originalSource);
        }
        const blockedParent = path.join(fixture.root, 'not-a-directory');
        fs.writeFileSync(blockedParent, 'not a directory');
        await assert.rejects(() => tool.execute({ ...inputs, outputPath: path.join(blockedParent, 'out.txt') }, token.token), /EEXIST|ENOTDIR/);
        vscode.workspace.isTrusted = false;
        await assert.rejects(() => tool.execute(inputs, token.token), /trusted/);
        vscode.workspace.isTrusted = true;
        const unsavedOutput = path.join(fixture.root, 'unsaved.txt');
        vscode.workspace.textDocuments = [{
            uri: vscode.Uri.file(inputs.filePath), isDirty: true, save: async () => false,
        }];
        await assert.rejects(() => tool.execute({ ...inputs, outputPath: unsavedOutput }, token.token), /Could not save/);
        assert(!fs.existsSync(unsavedOutput));
        const cancelledSave = new CancellationTokenSource();
        let finishSave;
        vscode.workspace.textDocuments[0].save = () => new Promise(resolve => { finishSave = resolve; });
        const saving = tool.execute({ ...inputs, outputPath: unsavedOutput }, cancelledSave.token);
        await waitFor(() => typeof finishSave === 'function', 'Document save did not start');
        cancelledSave.cancel();
        finishSave(true);
        await assert.rejects(saving, /Canceled/);
        assert(!fs.existsSync(unsavedOutput));
        cancelledSave.dispose();
        vscode.workspace.textDocuments = [];
        const preCancelled = new CancellationTokenSource();
        preCancelled.cancel();
        await assert.rejects(() => tool.execute(inputs, preCancelled.token), /Canceled/);
        preCancelled.dispose();
        const previousPath = process.env.PATH;
        try {
            process.env.PATH = path.join(fixture.root, 'missing-bin');
            await assert.rejects(() => tool.execute(inputs, token.token), /Select GAP Installation/);
        } finally {
            process.env.PATH = previousPath;
        }

        console.log('3. Live output before completion, parallel calls and output identity locking');
        const release = path.join(fixture.root, 'release');
        source(inputs.filePath, { waitFile: release });
        const secondOutput = path.join(fixture.root, 'parallel.txt');
        let settled = false;
        const first = tool.execute(inputs, token.token);
        first.then(() => { settled = true; }, () => { settled = true; });
        const second = tool.execute({ ...inputs, outputPath: secondOutput }, token.token);
        await Promise.all([record(inputs.outputPath, true), record(secondOutput, true)]);
        await waitFor(() => log(inputs.outputPath).includes('stderr\n'), 'stderr was not written live');
        assert.equal(settled, false);
        const runningLog = log(inputs.outputPath);
        await assert.rejects(() => tool.execute(inputs, token.token), /already writing/);
        const alias = path.join(fixture.root, 'output-alias.txt');
        fs.linkSync(inputs.outputPath, alias);
        await assert.rejects(() => tool.execute({ ...inputs, outputPath: alias }, token.token), /already writing/);
        assert.equal(log(inputs.outputPath), runningLog);
        fs.writeFileSync(release, '');
        assert.deepEqual(await Promise.all([first, second]), [{ completed: true }, { completed: true }]);
        await tool.execute(inputs, token.token);

        console.log('4. Cancellation and shutdown terminate the actual descendant process tree');
        source(inputs.filePath, { hang: true, spawnChild: true });
        const cancelled = new CancellationTokenSource();
        const hanging = tool.execute(inputs, cancelled.token);
        const rejected = assert.rejects(hanging, /Canceled/);
        const processes = await record(inputs.outputPath, true);
        cancelled.cancel();
        await rejected;
        await stopped(processes);
        cancelled.dispose();
        const closingTool = new RunFileTool(host);
        const closing = closingTool.execute(inputs, token.token);
        const closedInvocation = assert.rejects(closing, /Canceled/);
        const closingProcesses = await record(inputs.outputPath, true);
        await closingTool.close();
        await closedInvocation;
        await stopped(closingProcesses);
        await assert.rejects(() => closingTool.execute(inputs, token.token), /stopped/);
        source(inputs.filePath);
        await tool.execute(inputs, token.token);

        console.log('5. Native disable cancels work');
        const native = new LmToolsController(registry);
        controllers.push(native);
        source(inputs.filePath, { hang: true, spawnChild: true });
        const nativeRun = state.tools.get('gapRunFile').invoke({ input: inputs }, token.token);
        const nativeRejected = assert.rejects(nativeRun, /Canceled|disabled/);
        const nativeProcesses = await record(inputs.outputPath, true);
        setConfiguration({ 'gap.tools.enabled': false });
        await nativeRejected;
        await stopped(nativeProcesses);
        setConfiguration({ 'gap.tools.enabled': true });

        source(inputs.filePath);
        const busyOutput = path.join(fixture.root, 'busy.txt');
        source(inputs.filePath, { waitFile: path.join(fixture.root, 'release-native') });
        const holding = state.tools.get('gapRunFile').invoke({ input: { ...inputs, outputPath: busyOutput } }, token.token);
        await record(busyOutput, true);
        const conflict = await state.tools.get('gapRunFile').invoke({ input: { ...inputs, outputPath: busyOutput } }, token.token);
        assert.match(conflict.content[0].value, /already writing/, 'tool errors become the native result text');
        fs.writeFileSync(path.join(fixture.root, 'release-native'), '');
        assert.deepEqual(JSON.parse((await holding).content[0].value), { completed: true });
        source(inputs.filePath);

        console.log('6. Native launch and Windows/POSIX/WSL path and quoting matrix');
        for (const platform of ['linux', 'darwin']) {
            assert.deepEqual(nativeGapLaunch('/usr/bin/gap', '/a space/test.g', platform),
                { executable: '/usr/bin/gap', args: ['-q', '--nointeract', '*stdin*', '/a space/test.g'] });
        }
        const nativeFile = 'D:\\a space\\$special!%.g';
        assert.deepEqual(nativeGapLaunch('C:\\GAP\\gap.exe', nativeFile, 'win32').args, ['-q', '--nointeract', '*stdin*', nativeFile]);
        const batch = nativeGapLaunch('C:\\GAP install\\gap.cmd', 'D:\\a space\\test.g', 'win32');
        assert.equal(batch.windowsVerbatimArguments, true);
        assert.deepEqual(batch.args, ['/d', '/v:off', '/s', '/c', '""C:\\GAP install\\gap.cmd" -q --nointeract "*stdin*" "D:\\a space\\test.g""']);
        assert.throws(() => nativeGapLaunch('C:\\GAP\\gap.bat', nativeFile, 'win32'), /terminal would interpret/);
        const wsl = shellGapLaunch('wsl.exe', "/mnt/d/a'b $path.g", 'marker', { executable: 'wsl.exe', args: ['-d', 'Ubuntu'] }, '/mnt/d/root');
        assert.deepEqual(wsl.args.slice(0, 8), ['-d', 'Ubuntu', '--exec', 'setsid', '--wait', 'sh', '-c', wsl.args[7]],
            'setsid must wait: under wsl.exe it forks because it starts as a process group leader');
        assert(wsl.args[7].includes('exec 3>&1 4>&2'));
        assert(wsl.args[7].includes('marker:pid:'));
        assert(!wsl.args[7].includes('marker:ready'));
        assert(!wsl.args[7].includes('command -v gap'));
        assert(wsl.args[7].includes('exec gap -q --nointeract'));
        assert(wsl.args[7].includes('*stdin*'));
        assert(wsl.args[7].endsWith('1>&2 2>/dev/null'), 'interactive shell startup warnings are discarded');
        const changedCwd = shellGapLaunch('wsl.exe', '/mnt/d/test.g', 'marker',
            { executable: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '/some/old/folder'] });
        assert.deepEqual(changedCwd.protocol.wsl.args, ['-d', 'Ubuntu']);
        const bash = shellGapLaunch('/bin/bash', "/tmp/a'b.g", 'marker');
        assert.equal(bash.args[0], '-c');
        if (process.platform !== 'win32' && fs.existsSync('/bin/bash')) {
            // Run the launch script like WSL does: an interactive bash without a controlling terminal.
            const shellFile = path.join(fixture.root, "shell 'launch'.g");
            source(shellFile);
            const launch = shellGapLaunch('/bin/sh', shellFile, 'shellmarker', undefined, fixture.root);
            const ready = `GAP_RUN_READY_${'a'.repeat(32)}`;
            const child = spawn(launch.executable, launch.args, {
                detached: true, env: { ...process.env, SHELL: '/bin/bash', HOME: fixture.root },
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.stdin.end(`Print("${ready}");\n`);
            const code = await new Promise(resolve => child.once('close', resolve));
            assert.equal(code, 0, stderr);
            assert.match(stdout, /^shellmarker:pid:\d+\n/);
            assert(stdout.includes(ready) && stdout.includes('finished\n'), stdout);
            assert.equal(stderr, 'stderr\n', 'GAP keeps its stderr and the shell adds no job-control warnings');
        }
        const originalPlatform = os.platform;
        const originalShell = vscode.env.shell;
        try {
            os.platform = () => 'win32';
            setConfiguration({ 'gap.terminalRoot': '' });
            vscode.env.shell = 'C:\\Windows\\System32\\wsl.exe';
            assert.equal(toRuntimePath('D:\\a space\\test.g'), '/mnt/d/a space/test.g');
            assert.equal(toShellPath('D:\\a space\\test.g'), '"/mnt/d/a space/test.g"');
            setConfiguration({ 'gap.terminalRoot': '/' });
            assert.equal(toRuntimePath('D:\\a space\\test.g'), '/d/a space/test.g');
            setConfiguration({ 'gap.terminalRoot': '' });
            vscode.env.shell = 'C:\\Windows\\System32\\cmd.exe';
            assert.equal(toRuntimePath('D:\\a space\\test.g'), 'D:\\a space\\test.g');
            assert.equal(toShellPath('D:\\'), '"D:\\\\"');
            assert.equal(toShellPath('D:\\bad%path.g'), undefined);
            os.platform = () => 'darwin';
            assert.equal(toRuntimePath('/a space/test.g'), '/a space/test.g');
        } finally {
            os.platform = originalPlatform;
            vscode.env.shell = originalShell;
            setConfiguration({ 'gap.terminalRoot': '' });
        }
        console.log('All GAP file execution checks passed');
    } finally {
        vscode.workspace.isTrusted = true;
        vscode.workspace.textDocuments = [];
        vscode.workspace.getWorkspaceFolder = originalFolder;
        vscode.workspace.workspaceFolders = [];
        for (const controller of controllers) controller.dispose();
        await registry.close();
        await tool.close();
        token.dispose();
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
