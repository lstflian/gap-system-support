'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { toolOutput } = require('./helpers');
const { privateDirectory, controlKey, connectBroker, BROKER_PROTOCOL } = require('../../../out/mcp/shared');

function wait(child, type) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker ${type} timeout`)); }, 15000);
        const receive = message => {
            if (message.type !== type && message.type !== 'error') return;
            cleanup();
            if (message.type === 'error') reject(new Error(message.error));
            else resolve(message);
        };
        const exit = code => { cleanup(); reject(new Error(`Worker exited ${code} before ${type}`)); };
        const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); };
        child.on('message', receive);
        child.once('exit', exit);
    });
}
async function connect(url, headers) {
    const client = new Client({ name: 'shared-process-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
}
async function portClosed(port) {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => resolve(true));
    });
}
async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-mcp-process-'));
    const parent = path.join(temp, 'parent');
    const childRoot = path.join(parent, 'sub');
    const source = path.join(childRoot, 'sample.g');
    const explicit = path.join(temp, 'explicit cwd');
    const sharedStorage = path.join(temp, 'shared storage');
    fs.mkdirSync(sharedStorage, { recursive: true });
    fs.mkdirSync(childRoot, { recursive: true });
    fs.mkdirSync(explicit);
    fs.writeFileSync(source, 'Print("hello");\n');
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const instance = randomUUID();
    const token = randomBytes(32).toString('hex');
    const workers = [];
    const clients = [];
    try {
        function start(window, root) {
            const worker = fork(path.join(__dirname, 'process-worker.js'), [], {
                env: { ...process.env, GAP_WINDOW: window, GAP_ROOT: root, GAP_SOURCE: source,
                    GAP_INSTANCE: instance, GAP_TOKEN: token, GAP_PORT: String(port), GAP_SHARED_STORAGE: sharedStorage },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            workers.push(worker);
            worker.on('error', error => process.stderr.write(`${error}\n`));
            worker.stderr.on('data', chunk => process.stderr.write(chunk));
            const ready = wait(worker, 'ready');
            return { worker, ready };
        }
        const a = start('A', parent);
        const b = start('B', childRoot);
        const [aReady, bReady] = await Promise.all([a.ready, b.ready]);
        assert.equal(aReady.url, bReady.url, 'windows should share one actual listener');
        assert.equal(aReady.brokerPid, bReady.brokerPid, 'windows must attach to one independent process');
        assert.equal(new URL(aReady.url).port, String(port));
        assert.equal(aReady.headers.Authorization, bReady.headers.Authorization);
        assert.notEqual(aReady.headers['x-gap-window'], bReady.headers['x-gap-window']);
        const directory = await privateDirectory(sharedStorage, instance);
        const obsolete = await connectBroker(directory);
        try {
            const control = await controlKey(directory);
            await assert.rejects(() => obsolete.request('join', {
                control, protocol: BROKER_PROTOCOL - 1, windowId: randomUUID(),
                version: 'obsolete-worker', tools: [], configuration: { port, token, credentialKey: 'test', revision: 0 },
            }, undefined, 5000), /Incompatible GAP MCP service/);
        } finally { obsolete.close(); }
        const clientA = await connect(aReady.url, aReady.headers);
        const clientB = await connect(bReady.url, bReady.headers);
        const external = await connect(aReady.url, { Authorization: aReady.headers.Authorization });
        clients.push(clientA, clientB, external);
        const listed = await Promise.all(clients.map(client => client.callTool({ name: 'list_gap_books', arguments: {} })));
        assert(listed.every(value => toolOutput(value).books.length > 0), JSON.stringify(listed));
        const outputA = path.join(temp, 'a.json');
        const outputB = path.join(temp, 'b.json');
        const outputExt = path.join(temp, 'ext.json');
        const [callA, callB, callExt] = await Promise.all([
            clientA.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: outputA } }),
            clientB.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: outputB, cwd: explicit } }),
            external.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: outputExt } }),
        ]);
        assert([callA, callB, callExt].every(value => toolOutput(value).completed));
        const info = file => JSON.parse(fs.readFileSync(file, 'utf8').match(/\{[^\r\n]+\}/)[0]);
        assert.equal(info(outputA).cwd.toLowerCase(), parent.toLowerCase());
        assert.equal(info(outputB).cwd.toLowerCase(), explicit.toLowerCase());
        assert.equal(info(outputExt).cwd.toLowerCase(), childRoot.toLowerCase());
        assert.equal(info(outputA).args[0], '-q');
        console.log('Three concurrent clients route to A, B and the most-specific workspace respectively.');
        const dirtyB = wait(b.worker, 'dirty');
        b.worker.send({ type: 'dirty' });
        await dirtyB;
        const outputDirty = path.join(temp, 'dirty.txt');
        const dirtyResult = await external.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: outputDirty } });
        assert(toolOutput(dirtyResult).completed);
        assert(fs.readFileSync(source, 'utf8').includes('saved from window B'), 'B must save its dirty editor buffer');
        const [dirtyA, dirtyAgainB] = [wait(a.worker, 'dirty'), wait(b.worker, 'dirty')];
        a.worker.send({ type: 'dirty' });
        b.worker.send({ type: 'dirty' });
        await Promise.all([dirtyA, dirtyAgainB]);
        const ambiguous = await external.callTool({ name: 'run_gap_file', arguments: {
            filePath: source, outputPath: path.join(temp, 'ambiguous.txt'),
        } });
        assert(ambiguous.isError, 'external client must not choose among conflicting dirty documents');
        const internal = await clientA.callTool({ name: 'run_gap_file', arguments: {
            filePath: source, outputPath: path.join(temp, 'internal-a.txt'),
        } });
        assert(toolOutput(internal).completed, 'internal A request stays in A despite B dirty document');
        assert(fs.readFileSync(source, 'utf8').includes('saved from window A'));
        const cleared = await clientB.callTool({ name: 'run_gap_file', arguments: {
            filePath: source, outputPath: path.join(temp, 'internal-b.txt'),
        } });
        assert(toolOutput(cleared).completed);
        const outside = path.join(temp, 'outside.g');
        fs.writeFileSync(outside, 'Print("outside");\n');
        const outsideOutput = path.join(temp, 'outside.txt');
        const outsideResult = await clientA.callTool({ name: 'run_gap_file', arguments: {
            filePath: outside, outputPath: outsideOutput, cwd: explicit,
        } });
        assert(toolOutput(outsideResult).completed);
        assert.equal(info(outsideOutput).cwd.toLowerCase(), explicit.toLowerCase());
        const finish = path.join(temp, 'finish-run');
        const sharedOutput = path.join(temp, 'shared-output.txt');
        fs.writeFileSync(source, `# runner: ${JSON.stringify({ waitFile: finish })}\n`);
        const active = clientA.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: sharedOutput } });
        try {
            const deadline = Date.now() + 5000;
            const started = () => fs.existsSync(sharedOutput) && fs.readFileSync(sharedOutput, 'utf8').includes('stdout\n');
            while (!started() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            assert(started(), 'first invocation must write output before checking the shared file identity');
            const conflict = await clientB.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: sharedOutput } });
            assert.equal(conflict.isError, true, 'different windows cannot write the same output simultaneously');
            const alias = path.join(temp, 'shared-output-alias.txt');
            fs.linkSync(sharedOutput, alias);
            const beforeConflict = fs.readFileSync(sharedOutput, 'utf8');
            const aliasConflict = await clientB.callTool({ name: 'run_gap_file', arguments: { filePath: outside, outputPath: alias } });
            assert.equal(aliasConflict.isError, true, 'a hard link created after output creation shares the active identity lock');
            assert.equal(fs.readFileSync(sharedOutput, 'utf8'), beforeConflict, 'a rejected alias must not truncate active output');
            fs.writeFileSync(finish, 'done');
            assert(toolOutput(await active).completed);
            assert(toolOutput(await clientB.callTool({ name: 'run_gap_file', arguments: { filePath: outside, outputPath: alias } })).completed,
                'a completed invocation releases its identity lock and permits overwriting through an alias');
        } finally { fs.writeFileSync(finish, 'done'); await active.catch(() => {}); }
        const failingSource = path.join(childRoot, 'startup-failure.g');
        const failedOutput = path.join(temp, 'failed-output.txt');
        fs.writeFileSync(failingSource, `# runner: ${JSON.stringify({ startupExitCode: 0 })}\n`);
        const failed = await clientA.callTool({ name: 'run_gap_file', arguments: { filePath: failingSource, outputPath: failedOutput } });
        assert.equal(failed.isError, true, 'startup failure is still a tool error after claiming output');
        const failedAlias = path.join(temp, 'failed-output-alias.txt');
        fs.linkSync(failedOutput, failedAlias);
        assert(toolOutput(await clientB.callTool({ name: 'run_gap_file', arguments: { filePath: outside, outputPath: failedAlias } })).completed,
            'startup failure releases its shared identity claim');

        const largeOutput = path.join(temp, 'large-output.txt');
        const largeRelease = path.join(temp, 'large-release');
        const stdoutBytes = 20 * 1024 * 1024;
        const stderrBytes = 2 * 1024 * 1024;
        fs.writeFileSync(source, `# runner: ${JSON.stringify({ bytes: stdoutBytes, stderr: 'Y'.repeat(stderrBytes), waitFile: largeRelease })}\n`);
        const large = clientB.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: largeOutput } });
        const count = (data, byte) => { let total = 0; for (const value of data) if (value === byte) total++; return total; };
        try {
            const deadline = Date.now() + 15000;
            let complete = false;
            while (Date.now() < deadline) {
                if (fs.existsSync(largeOutput) && fs.statSync(largeOutput).size >= stdoutBytes + stderrBytes) {
                    const bytes = fs.readFileSync(largeOutput);
                    if (count(bytes, 120) >= stdoutBytes && count(bytes, 89) === stderrBytes) { complete = true; break; }
                }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            assert(complete, 'both output streams must be visible while the large invocation is still running');
            assert(toolOutput(await clientA.callTool({ name: 'list_gap_books', arguments: {} })).books.length > 0,
                'large logs must not block control or help requests');
        } finally { fs.writeFileSync(largeRelease, 'done'); }
        assert(toolOutput(await large).completed);
        const largeBytes = fs.readFileSync(largeOutput);
        assert.equal(count(largeBytes, 120), stdoutBytes + count(Buffer.from(JSON.stringify(info(largeOutput)) + '\nstdout\nfinished\n'), 120),
            'stdout larger than the IPC frame limit must arrive without losing or duplicating bytes');
        assert.equal(count(largeBytes, 89), stderrBytes);
        assert(largeBytes.includes(Buffer.from('finished\n')));
        console.log('Large stdout and stderr stream live without overflowing control IPC.');

        const cancelRelease = path.join(temp, 'cancel-release');
        const cancelOutput = path.join(temp, 'cancel-output.txt');
        fs.writeFileSync(source, `# runner: ${JSON.stringify({ waitFile: cancelRelease })}\n`);
        const cancel = new AbortController();
        const cancelling = clientB.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: cancelOutput } },
            { signal: cancel.signal }).catch(() => ({ isError: true }));
        const cancelDeadline = Date.now() + 10000;
        while ((!fs.existsSync(cancelOutput) || !fs.readFileSync(cancelOutput, 'utf8').includes('stdout\n')) && Date.now() < cancelDeadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert(fs.readFileSync(cancelOutput, 'utf8').includes('stdout\n'));
        const cancellingPid = info(cancelOutput).pid;
        cancel.abort();
        assert((await cancelling).isError);
        const stopDeadline = Date.now() + 10000;
        const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
        while (alive(cancellingPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(alive(cancellingPid), false, 'shared MCP cancellation must stop the actual GAP process');
        const retryDeadline = Date.now() + 5000;
        let reused;
        do {
            reused = await clientA.callTool({ name: 'run_gap_file', arguments: { filePath: outside, outputPath: cancelOutput } });
            if (!reused.isError) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < retryDeadline);
        assert(toolOutput(reused).completed, 'cancelled MCP output must become reusable');
        console.log('Shared MCP cancellation stops GAP and releases its output for another window.');
        const closedA = wait(a.worker, 'closed');
        a.worker.send({ type: 'close' });
        await closedA;
        assert.equal(await portClosed(port), false, 'closing initial worker must not close broker');
        assert.doesNotThrow(() => process.kill(aReady.brokerPid, 0), 'broker process must survive its initial worker');
        assert(toolOutput(await clientB.callTool({ name: 'list_gap_books', arguments: {} })).books.length > 0);
        assert(toolOutput(await external.callTool({ name: 'list_gap_books', arguments: {} })).books.length > 0);
        const old = await clientA.callTool({ name: 'list_gap_books', arguments: {} }).catch(() => ({ isError: true }));
        assert(old.isError, 'closed origin must not silently reroute to B');
        console.log('Closing the creator does not interrupt B or external clients.');
        const closedB = wait(b.worker, 'closed');
        b.worker.send({ type: 'close' });
        await closedB;
        const deadline = Date.now() + 12000;
        while (!await portClosed(port) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(await portClosed(port), true, 'broker should exit after last window closes');
        const processDeadline = Date.now() + 5000;
        let brokerExited = false;
        while (Date.now() < processDeadline) {
            try { process.kill(aReady.brokerPid, 0); }
            catch { brokerExited = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert(brokerExited, 'broker process must exit after the last participating window closes');
        console.log('The listener and broker process exit after the last participating window closes.');
    } finally {
        for (const client of clients) await client.close().catch(() => {});
        for (const worker of workers) {
            if (worker.exitCode === null && worker.connected) {
                const closed = wait(worker, 'closed').catch(() => {});
                worker.send({ type: 'close' });
                await closed;
            }
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
