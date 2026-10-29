'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { privateDirectory, controlKey, connectBroker, connectPeer, ipcAddress, BROKER_PROTOCOL } = require('../../../out/mcp/shared');
const { toolOutput } = require('./helpers');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function until(predicate, message) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
function pathKey(file) { return 'path:' + (process.platform === 'win32' ? file.toLowerCase() : file); }
async function metadata(output, source) {
    const handle = await fs.open(output, 'a');
    try {
        const [actual, input] = await Promise.all([handle.stat({ bigint: true }), fs.stat(source, { bigint: true })]);
        return { path: pathKey(await fs.realpath(output)), sourcePath: pathKey(await fs.realpath(source)),
            identity: actual.ino ? `file:${actual.dev}:${actual.ino}` : undefined,
            sourceIdentity: input.ino ? `file:${input.dev}:${input.ino}` : undefined };
    } finally { await handle.close(); }
}

async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-broker-output-'));
    const source = path.join(temp, 'source.g');
    const output = path.join(temp, 'output.txt');
    await fs.writeFile(source, 'source');
    const directory = await privateDirectory(path.join(temp, 'storage'), randomUUID());
    const control = await controlKey(directory);
    const configuration = { port: 0, token: randomBytes(32).toString('hex'), credentialKey: 'test', revision: 0 };
    const metadataTool = require('../../../package.json').contributes.languageModelTools.find(tool => tool.name === 'run_gap_file');
    const peers = new Set();
    const clients = [];
    const heartbeats = [];
    const gates = [];
    const pids = new Set();
    async function worker(label, mode = 'normal') {
        const peer = await connectBroker(directory);
        peers.add(peer);
        const started = deferred();
        const release = deferred();
        const completed = deferred();
        gates.push(release);
        const state = { peer, started, release, completed, active: false, stream: undefined, invocation: undefined };
        peer.handler = async (method, value) => {
            if (method === 'endpoint') return null;
            if (method === 'current') return true;
            if (method === 'locate') return { open: false, dirty: false };
            if (method !== 'execute') throw new Error('Unexpected method');
            state.active = true;
            try {
                const input = value.input;
                state.invocation = value.outputClaimId;
                if (mode === 'before-open') { started.resolve(); await release.promise; }
                const expected = await metadata(input.outputPath, input.filePath);
                const stream = await connectPeer(ipcAddress(directory));
                peers.add(stream);
                state.stream = stream;
                await stream.request('output', { ...expected, control, invocationId: value.outputClaimId });
                await stream.request('truncate', null);
                await stream.request('write', Buffer.from(label).toString('base64'));
                if (mode === 'hold') {
                    started.resolve();
                    await release.promise; // Simulate a writer whose process cleanup outlives the main IPC connection.
                    await stream.request('write', Buffer.from(' OBSOLETE').toString('base64'));
                }
                await stream.request('finish', null);
                stream.close();
                return { completed: true };
            } finally { state.active = false; completed.resolve(); }
        };
        state.endpoint = await peer.request('join', { control, protocol: BROKER_PROTOCOL, windowId: randomUUID(),
            version: 'output-fault-tests', tools: [{ metadata: metadataTool }], configuration });
        pids.add(state.endpoint.pid);
        const timer = setInterval(() => { void peer.request('ping', null).catch(() => {}); }, 1000);
        timer.unref();
        heartbeats.push(timer);
        const client = new Client({ name: 'output-fault-test', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(state.endpoint.url), {
            requestInit: { headers: { Authorization: state.endpoint.authorization, 'x-gap-window': state.endpoint.windowKey } },
        }));
        clients.push(client);
        state.call = () => client.callTool({ name: 'run_gap_file', arguments: { filePath: source, outputPath: output } })
            .catch(error => ({ isError: true, error }));
        return state;
    }
    try {
        const a = await worker('A', 'hold');
        const b = await worker('B');
        const pendingA = a.call();
        await a.started.promise;
        assert.equal(await fs.readFile(output, 'utf8'), 'A');
        a.peer.close();
        assert.equal((await pendingA).isError, true);
        assert.equal(a.active, true, 'old execution must still be alive during reuse');
        assert.equal(toolOutput(await b.call()).completed, true);
        a.release.resolve();
        await a.completed.promise;
        assert.equal(await fs.readFile(output, 'utf8'), 'B');
        await assert.rejects(a.stream.request('write', Buffer.from('late').toString('base64')), /closed/);
        const stale = await connectPeer(ipcAddress(directory));
        peers.add(stale);
        await assert.rejects(stale.request('output', { ...await metadata(output, source), control, invocationId: a.invocation }),
            /no longer available/);
        stale.close();
        console.log('Main IPC loss permits safe reuse while the old execution is still alive; stale writers are rejected.');

        const validating = await worker('VALIDATING', 'before-open');
        const pendingValidation = validating.call();
        await validating.started.promise;
        validating.peer.close();
        assert.equal((await pendingValidation).isError, true);
        assert.equal(toolOutput(await b.call()).completed, true);
        validating.release.resolve();
        await validating.completed.promise;
        assert.equal(await fs.readFile(output, 'utf8'), 'B');
        console.log('A connection lost before opening output cannot later truncate a replacement invocation.');

        const streamLost = await worker('STREAM', 'hold');
        const pendingStream = streamLost.call();
        await streamLost.started.promise;
        streamLost.stream.close();
        streamLost.release.resolve();
        assert.equal((await pendingStream).isError, true);
        assert.equal(toolOutput(await b.call()).completed, true);
        assert.equal(await fs.readFile(output, 'utf8'), 'B');
        console.log('Output-only disconnect cancels the invocation and leaves the broker available.');

        const crashing = await worker('OLD BROKER', 'hold');
        const pendingCrash = crashing.call();
        await crashing.started.promise;
        process.kill(crashing.endpoint.pid, 'SIGKILL');
        await until(() => crashing.peer.closed, 'crashed broker did not close IPC');
        assert.equal((await pendingCrash).isError, true);
        const replacement = await worker('NEW BROKER');
        assert.notEqual(replacement.endpoint.pid, crashing.endpoint.pid);
        assert.equal(toolOutput(await replacement.call()).completed, true);
        assert.equal(crashing.active, true);
        crashing.release.resolve();
        await crashing.completed.promise;
        assert.equal(await fs.readFile(output, 'utf8'), 'NEW BROKER');
        console.log('Broker restart cannot leave an old worker with a writable output handle.');
    } finally {
        for (const gate of gates) gate.resolve();
        for (const timer of heartbeats) clearInterval(timer);
        for (const client of clients) await client.close().catch(() => {});
        for (const peer of peers) peer.close();
        for (const pid of pids) {
            await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'broker failed to exit');
        }
        assert.equal(path.dirname(await fs.realpath(temp)).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
        await fs.rm(temp, { recursive: true, force: true });
        if (process.platform !== 'win32') {
            assert(path.basename(directory).startsWith('gap-mcp-'));
            assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
