'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BrokerOutput } = require('../../../out/mcp/output');
const { OUTPUT_CHUNK_SIZE } = require('../../../out/mcp/shared');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function key(file) { return 'path:' + (process.platform === 'win32' ? file.toLowerCase() : file); }
async function metadata(file, source) {
    const [actual, input] = await Promise.all([fs.stat(file, { bigint: true }), fs.stat(source, { bigint: true })]);
    return { path: key(await fs.realpath(file)), sourcePath: key(await fs.realpath(source)),
        identity: actual.ino ? `file:${actual.dev}:${actual.ino}` : undefined,
        sourceIdentity: input.ino ? `file:${input.dev}:${input.ino}` : undefined };
}
async function patchOpen(file, wrap, action) {
    const original = fs.open;
    fs.open = async (...args) => {
        const handle = await original(...args);
        return args[0] === file ? wrap(handle) : handle;
    };
    try { await action(); }
    finally { fs.open = original; }
}
function proxy(handle, overrides) {
    return new Proxy(handle, { get(target, name) {
        if (name in overrides) return overrides[name];
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

async function main() {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-output-test-'));
    const file = path.join(temp, 'output.bin');
    const source = path.join(temp, 'source.g');
    await fs.writeFile(source, 'source must survive');
    await fs.writeFile(file, 'old output');
    try {
        const expected = await metadata(file, source);
        const claims = [];
        const writer = new BrokerOutput(file, source, identity => claims.push(identity));
        await writer.open(expected);
        await writer.truncate();
        const bytes = Buffer.alloc(OUTPUT_CHUNK_SIZE * 5 + 17);
        for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
        for (let offset = 0; offset < bytes.length; offset += OUTPUT_CHUNK_SIZE) {
            await writer.write(bytes.subarray(offset, offset + OUTPUT_CHUNK_SIZE).toString('base64'));
        }
        await writer.close();
        assert.deepEqual(await fs.readFile(file), bytes);
        assert(claims.includes(expected.identity));
        console.log('Binary chunks preserve all bytes and retain the opened file identity.');

        await fs.writeFile(file, 'preserve on identity mismatch');
        const mismatch = new BrokerOutput(file, source, () => {});
        await assert.rejects(mismatch.open({ ...expected, identity: 'file:1:1' }), /changed before execution/);
        await assert.rejects(mismatch.close(), /changed before execution/);
        assert.equal(await fs.readFile(file, 'utf8'), 'preserve on identity mismatch');
        const alias = path.join(temp, 'source-alias.g');
        await fs.link(source, alias);
        const inputAlias = new BrokerOutput(alias, source, () => {});
        await assert.rejects(inputAlias.open(await metadata(alias, source)), /source file/);
        await assert.rejects(inputAlias.close(), /source file/);
        assert.equal(await fs.readFile(source, 'utf8'), 'source must survive');
        console.log('Changed identities and source hard links fail before truncation.');

        let zeroClaims = 0;
        await patchOpen(file, handle => proxy(handle, { async stat() {
            const stat = await handle.stat({ bigint: true });
            return proxy(stat, { ino: 0n });
        } }), async () => {
            const zero = new BrokerOutput(file, source, identity => { if (identity.startsWith('file:')) zeroClaims++; });
            await zero.open({ ...await metadata(file, source), identity: undefined });
            await zero.truncate();
            await zero.write(Buffer.from('zero inode fallback').toString('base64'));
            await zero.close();
        });
        assert.equal(zeroClaims, 0);
        assert.equal(await fs.readFile(file, 'utf8'), 'zero inode fallback');
        console.log('Filesystems reporting inode zero keep canonical-path execution.');

        const opened = deferred();
        const allowOpen = deferred();
        let handleAfterOpen;
        await patchOpen(file, handle => {
            handleAfterOpen = handle;
            return proxy(handle, { async stat(options) { opened.resolve(); await allowOpen.promise; return handle.stat(options); } });
        }, async () => {
            const opening = new BrokerOutput(file, source, () => {});
            const ready = opening.open(await metadata(file, source));
            await opened.promise;
            let closed = false;
            const closing = opening.close().then(() => { closed = true; });
            await assert.rejects(opening.truncate(), /closed/);
            assert.equal(closed, false);
            allowOpen.resolve();
            await ready;
            await closing;
            assert.equal(handleAfterOpen.fd, -1);
        });
        console.log('Disconnect during open waits for the pending handle and closes it.');

        const writing = deferred();
        const allowWrite = deferred();
        let closeCount = 0;
        await patchOpen(file, handle => proxy(handle, {
            async write(...args) { writing.resolve(); await allowWrite.promise; return handle.write(...args); },
            async close() { closeCount++; await handle.close(); },
        }), async () => {
            const active = new BrokerOutput(file, source, () => {});
            await active.open(await metadata(file, source));
            await active.truncate();
            const pending = active.write(Buffer.from('accepted write').toString('base64'));
            await writing.promise;
            const closing = active.close();
            assert.equal(active.close(), closing);
            await assert.rejects(active.write(Buffer.from('late write').toString('base64')), /closed/);
            assert.equal(closeCount, 0);
            allowWrite.resolve();
            await pending;
            await closing;
            assert.equal(closeCount, 1);
            await fs.writeFile(file, 'NEW OWNER');
            await assert.rejects(active.write(Buffer.from('obsolete writer').toString('base64')), /closed/);
            assert.equal(await fs.readFile(file, 'utf8'), 'NEW OWNER');
        });
        console.log('Accepted writes drain before close; late writes cannot alter a new owner.');

        let writes = 0;
        await patchOpen(file, handle => proxy(handle, { async write(buffer, offset, length, position) {
            writes++;
            return handle.write(buffer, offset, Math.min(length, 3), position);
        } }), async () => {
            const partial = new BrokerOutput(file, source, () => {});
            await partial.open(await metadata(file, source));
            await partial.truncate();
            await partial.write(Buffer.from('partial writes preserve bytes').toString('base64'));
            await partial.close();
        });
        assert(writes > 1);
        assert.equal(await fs.readFile(file, 'utf8'), 'partial writes preserve bytes');

        let failedClosed = false;
        await patchOpen(file, handle => proxy(handle, {
            async write() { throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' }); },
            async close() { failedClosed = true; await handle.close(); },
        }), async () => {
            const failed = new BrokerOutput(file, source, () => {});
            await failed.open(await metadata(file, source));
            await failed.truncate();
            await assert.rejects(failed.write(Buffer.from('data').toString('base64')), /ENOSPC/);
            await assert.rejects(failed.close(), /ENOSPC/);
            assert.equal(failedClosed, true);
        });
        console.log('Partial writes are completed; disk failures still close their file handle.');
    } finally {
        assert.equal(path.dirname(await fs.realpath(temp)).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase());
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
