'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { acquireStartupLock } = require('../../../out/mcp/startup');
const { connectBroker, controlKey } = require('../../../out/mcp/shared');

async function main() {
    if (process.platform === 'win32') {
        console.log('Unix startup integration skipped on Windows; deterministic startup interleavings run separately.');
        return;
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-startup-integration-'));
    const children = [];
    const peers = [];
    try {
        const modulePath = require.resolve('../../../out/mcp/startup');
        const holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).acquireStartupLock(process.argv[1]).then(() => { console.log('locked'); setInterval(() => {}, 1000); });`, directory],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(holder);
        await new Promise((resolve, reject) => {
            holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('lock holder exited early')));
        });
        const exited = new Promise(resolve => holder.once('exit', resolve));
        holder.kill('SIGKILL'); await exited;
        const release = await acquireStartupLock(directory); await release();
        await fs.mkdir(path.join(directory, 'startup.lock'));
        const empty = await acquireStartupLock(directory); await empty();
        console.log('Actual Unix processes recover SIGKILL and empty startup-lock residues.');

        await controlKey(directory);
        const brokerPath = require.resolve('../../../out/mcp/broker');
        for (let index = 0; index < 6; index++) {
            children.push(spawn(process.execPath, [brokerPath, directory], { stdio: 'ignore' }));
        }
        peers.push(...await Promise.all(Array.from({ length: 4 }, () => connectBroker(directory))));
        const token = require('node:crypto').randomBytes(32).toString('hex');
        const configuration = { port: 0, token, credentialKey: 'integration', revision: 0 };
        const { BROKER_PROTOCOL } = require('../../../out/mcp/shared');
        const control = await controlKey(directory);
        const endpoints = await Promise.all(peers.map(peer => peer.request('join', {
            control, protocol: BROKER_PROTOCOL, windowId: randomUUID(), version: 'startup-integration', tools: [], configuration,
        })));
        assert.equal(new Set(endpoints.map(endpoint => endpoint.pid)).size, 1);
        assert.equal(new Set(endpoints.map(endpoint => endpoint.url)).size, 1);
        const brokerPid = endpoints[0].pid;
        const closed = Promise.all(peers.map(peer => new Promise(resolve => { peer.onClose = resolve; })));
        process.kill(brokerPid, 'SIGKILL'); await closed;
        const replacement = await connectBroker(directory); peers.push(replacement);
        const next = await replacement.request('join', { control, protocol: BROKER_PROTOCOL, windowId: randomUUID(),
            version: 'startup-integration', tools: [], configuration });
        assert.notEqual(next.pid, brokerPid);
        await replacement.request('leave', null);
        replacement.close();
        console.log('Concurrent Unix candidates converge, and a crashed listening broker recovers.');
    } finally {
        for (const peer of peers) peer.close();
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise(resolve => child.once('exit', resolve));
                child.kill('SIGKILL'); await exited;
            }
        }
        assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
