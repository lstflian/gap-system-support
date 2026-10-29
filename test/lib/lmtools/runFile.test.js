'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, CancellationTokenSource,
} = require('./mock-vscode');
const { RunFileTool } = require('../../../out/lmtools/runFileTool');
const { nativeGapLaunch, shellGapLaunch } = require('../../../out/shared/gapRun');
const { toRuntimePath, toShellPath } = require('../../../out/path');
const { createToolRegistry } = require('../../../out/lmtools/registry');
const { LmToolsController } = require('../../../out/lmtools');
const { startMcpServer } = require('../../../out/mcp/server');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { MCP_MAX_LEGACY_SESSIONS, MCP_LEGACY_SESSION_IDLE_MS } = require('../../../out/limits');

async function initialize(server) {
    const response = await fetch(server.url, {
        method: 'POST',
        headers: {
            Authorization: server.authorization, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'session-tests', version: '1' } },
        }),
    });
    await response.text();
    return { status: response.status, id: response.headers.get('mcp-session-id') };
}

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
    const tool = new RunFileTool();
    const registry = createToolRegistry(fixture.context);
    const token = new CancellationTokenSource();
    const inputs = fixture.inputs.run_gap_file;
    const originalFolder = vscode.workspace.getWorkspaceFolder;
    const controllers = [];
    const servers = [];
    const clients = [];
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
        const preparation = tool.prepareInvocation({ input: { filePath: file, outputPath: output } });
        assert(preparation.confirmationMessages.message.includes(output));
        assert(preparation.confirmationMessages.message.includes(file));
        const overrideCwd = path.join(fixture.root, 'explicit cwd');
        fs.mkdirSync(overrideCwd);
        const overrideInput = { filePath: file, outputPath: output, cwd: overrideCwd };
        await tool.execute(overrideInput, token.token);
        assert.equal((await record(output)).cwd.toLowerCase(), overrideCwd.toLowerCase());
        assert(tool.prepareInvocation({ input: overrideInput }).confirmationMessages.message.includes(overrideCwd));
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

        const preserved = log(inputs.outputPath);
        const identity = fs.statSync(inputs.outputPath, { bigint: true });
        await assert.rejects(() => tool.execute(inputs, token.token, {
            async claimOutput(value) {
                assert.equal(value, `file:${identity.dev}:${identity.ino}`);
                assert.equal(log(inputs.outputPath), preserved, 'shared identity is claimed before truncation');
                throw new Error('test shared output conflict');
            },
        }), /test shared output conflict/);
        assert.equal(log(inputs.outputPath), preserved, 'failed shared claim preserves existing output');
        const claimCancellation = new CancellationTokenSource();
        let enteredClaim;
        let releaseClaim;
        const claimEntered = new Promise(resolve => { enteredClaim = resolve; });
        const claimGate = new Promise(resolve => { releaseClaim = resolve; });
        const pendingClaim = tool.execute(inputs, claimCancellation.token, {
            async claimOutput() { enteredClaim(); await claimGate; },
        });
        const cancelledClaim = assert.rejects(pendingClaim, /Canceled/);
        await claimEntered;
        claimCancellation.cancel();
        releaseClaim();
        await cancelledClaim;
        claimCancellation.dispose();
        assert.equal(log(inputs.outputPath), preserved, 'cancellation during the shared claim preserves output');
        await tool.execute(inputs, token.token);
        assert(log(inputs.outputPath).includes('finished\n'), 'native execution reuses output after failed/cancelled claims');

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
            await assert.rejects(() => tool.execute(inputs, token.token), /PATH/);
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
        const closingTool = new RunFileTool();
        const closing = closingTool.execute(inputs, token.token);
        const closedInvocation = assert.rejects(closing, /Canceled/);
        const closingProcesses = await record(inputs.outputPath, true);
        await closingTool.close();
        await closedInvocation;
        await stopped(closingProcesses);
        await assert.rejects(() => closingTool.execute(inputs, token.token), /stopped/);
        source(inputs.filePath);
        await tool.execute(inputs, token.token);

        console.log('5. Native disable cancels work, while both interfaces share output locks');
        const native = new LmToolsController(registry);
        controllers.push(native);
        source(inputs.filePath, { hang: true, spawnChild: true });
        const nativeRun = state.tools.get('run_gap_file').invoke({ input: inputs }, token.token);
        const nativeRejected = assert.rejects(nativeRun, /Canceled|disabled/);
        const nativeProcesses = await record(inputs.outputPath, true);
        setConfiguration({ 'gap.tools.enabled': false });
        await nativeRejected;
        await stopped(nativeProcesses);
        setConfiguration({ 'gap.tools.enabled': true });

        for (const modern of [false, true]) {
            console.log(`6. ${modern ? 'Modern' : 'Legacy'} MCP live output, shared locking and request cancellation`);
            const server = await startMcpServer(registry, () => true, error => { throw error; }, randomBytes(32).toString('hex'));
            servers.push(server);
            const client = new Client({ name: 'gap-run-test', version: '1' },
                modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
            clients.push(client);
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: { Authorization: server.authorization } },
            }));
            const abort = new AbortController();
            const pending = client.callTool({ name: 'run_gap_file', arguments: inputs }, { signal: abort.signal })
                .then(value => ({ value }), error => ({ error }));
            const mcpProcesses = await record(inputs.outputPath, true);
            const conflict = await state.tools.get('run_gap_file').invoke({ input: inputs }, token.token);
            assert.match(conflict.content[0].value, /already writing/);
            const otherSource = path.join(fixture.root, 'other.g');
            source(otherSource);
            const independent = await state.tools.get('run_gap_file').invoke({
                input: { filePath: otherSource, outputPath: secondOutput },
            }, token.token);
            assert.deepEqual(JSON.parse(independent.content[0].value), { completed: true });
            abort.abort();
            assert((await pending).error);
            await stopped(mcpProcesses);
            await client.close();
            clients.pop();
            await server.close();
            servers.pop();
        }

        console.log('7. Stopping MCP cancels a real running GAP invocation');
        const server = await startMcpServer(registry, () => true, error => { throw error; }, randomBytes(32).toString('hex'));
        servers.push(server);
        const client = new Client({ name: 'gap-run-shutdown', version: '1' });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: { Authorization: server.authorization } },
        }));
        const pending = client.callTool({ name: 'run_gap_file', arguments: inputs })
            .then(value => ({ value }), error => ({ error }));
        const shutdownProcesses = await record(inputs.outputPath, true);
        await server.close();
        const outcome = await pending;
        assert(outcome.error || outcome.value.isError);
        await stopped(shutdownProcesses);

        console.log('8. Legacy clients with identical request IDs cannot cancel each other');
        const isolated = await startMcpServer(registry, () => true, error => { throw error; }, randomBytes(32).toString('hex'));
        servers.push(isolated);
        const peers = [];
        for (const suffix of ['a', 'b']) {
            const peer = new Client({ name: 'same-client-info', version: '1' });
            const transport = new StreamableHTTPClientTransport(new URL(isolated.url), {
                requestInit: { headers: { Authorization: isolated.authorization } },
            });
            clients.push(peer);
            await peer.connect(transport);
            const abort = new AbortController();
            const peerInput = { ...inputs, outputPath: path.join(fixture.root, `peer-${suffix}.txt`) };
            const pending = peer.callTool({ name: 'run_gap_file', arguments: peerInput }, { signal: abort.signal })
                .then(value => ({ value }), error => ({ error }));
            peers.push({ peer, transport, abort, pending, processes: await record(peerInput.outputPath, true) });
        }
        assert(peers[0].transport.sessionId);
        assert.notEqual(peers[0].transport.sessionId, peers[1].transport.sessionId);
        peers[0].abort.abort();
        assert((await peers[0].pending).error);
        await stopped(peers[0].processes);
        assert(alive(peers[1].processes.pid));
        const clock = Date.now;
        try {
            Date.now = () => clock() + MCP_LEGACY_SESSION_IDLE_MS + 1;
            assert.equal((await initialize(isolated)).status, 200);
            assert.equal((await peers[1].peer.listTools()).tools.length, 5);
            assert(alive(peers[1].processes.pid), 'Idle expiry killed a running call');
        } finally {
            Date.now = clock;
        }
        await peers[1].peer.close();
        await peers[1].pending;
        await stopped(peers[1].processes);

        console.log('9. Legacy session capacity, explicit deletion and idle expiry');
        const bounded = await startMcpServer(registry, () => true, error => { throw error; }, randomBytes(32).toString('hex'));
        servers.push(bounded);
        const initialized = await Promise.all(Array.from({ length: MCP_MAX_LEGACY_SESSIONS + 1 }, () => initialize(bounded)));
        assert.equal(initialized.filter(value => value.status === 200).length, MCP_MAX_LEGACY_SESSIONS);
        assert.equal(initialized.filter(value => value.status === 503).length, 1);
        const victim = initialized.find(value => value.id).id;
        const expiredId = initialized.filter(value => value.id)[1].id;
        const deleted = await fetch(bounded.url, {
            method: 'DELETE', headers: { Authorization: bounded.authorization, 'mcp-session-id': victim },
        });
        await deleted.text();
        assert.equal(deleted.status, 200);
        assert.equal((await initialize(bounded)).status, 200);
        try {
            Date.now = () => clock() + MCP_LEGACY_SESSION_IDLE_MS + 1;
            assert.equal((await initialize(bounded)).status, 200);
        } finally {
            Date.now = clock;
        }
        const stale = await fetch(bounded.url, {
            method: 'GET', headers: { Authorization: bounded.authorization, 'mcp-session-id': expiredId },
        });
        await stale.text();
        assert.equal(stale.status, 404);
        const stateless = await fetch(bounded.url, {
            method: 'POST',
            headers: {
                Authorization: bounded.authorization, 'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_gap_file', arguments: inputs } }),
            signal: AbortSignal.timeout(10000),
        });
        assert.match(await stateless.text(), /Initialize an MCP session/);

        console.log('10. Native launch and Windows/POSIX/WSL path and quoting matrix');
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
        assert.deepEqual(wsl.args.slice(0, 7), ['-d', 'Ubuntu', '--exec', 'setsid', 'sh', '-c', wsl.args[6]]);
        assert(wsl.args[6].includes('exec 3>&1'));
        assert(wsl.args[6].includes('marker:pid:'));
        assert(!wsl.args[6].includes('marker:ready'));
        assert(!wsl.args[6].includes('command -v gap'));
        assert(wsl.args[6].includes('exec gap -q --nointeract'));
        assert(wsl.args[6].includes('*stdin*'));
        const changedCwd = shellGapLaunch('wsl.exe', '/mnt/d/test.g', 'marker',
            { executable: 'wsl.exe', args: ['-d', 'Ubuntu', '--cd', '/some/old/folder'] });
        assert.deepEqual(changedCwd.protocol.wsl.args, ['-d', 'Ubuntu']);
        const bash = shellGapLaunch('/bin/bash', "/tmp/a'b.g", 'marker');
        assert.equal(bash.args[0], '-c');
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
        for (const server of servers) await server.close();
        await registry.close();
        await tool.close();
        for (const client of clients) await client.close();
        token.dispose();
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
