'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = require.resolve('../../../out/mcp/startup');
const source = require('node:fs').readFileSync(modulePath, 'utf8');
const error = code => Object.assign(new Error(code), { code });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// POSIX filesystem semantics allow replacing an empty directory, never a nonempty one.
class FileSystem {
    constructor() { this.directories = new Map([['/private', new Set()]]); this.counter = 0; this.onUnlink = undefined; this.onRmdir = undefined; }
    async mkdtemp(prefix) { const result = prefix + (++this.counter); this.directories.set(result, new Set()); return result; }
    async writeFile(file) {
        const directory = this.directories.get(path.posix.dirname(file));
        if (!directory) throw error('ENOENT');
        if (directory.has(path.posix.basename(file))) throw error('EEXIST');
        directory.add(path.posix.basename(file));
    }
    async rename(from, to) {
        const entry = this.directories.get(from);
        if (!entry) throw error('ENOENT');
        if (this.directories.get(to)?.size) throw error('ENOTEMPTY');
        this.directories.set(to, entry);
        this.directories.delete(from);
    }
    async readdir(directory) {
        if (!this.directories.has(directory)) throw error('ENOENT');
        return [...this.directories.get(directory)];
    }
    async unlink(file) {
        if (this.onUnlink) await this.onUnlink(file);
        const directory = this.directories.get(path.posix.dirname(file));
        if (!directory?.delete(path.posix.basename(file))) throw error('ENOENT');
    }
    async rmdir(directory) {
        if (this.onRmdir) await this.onRmdir(directory);
        if (!this.directories.has(directory)) throw error('ENOENT');
        if (this.directories.get(directory).size) throw error('ENOTEMPTY');
        this.directories.delete(directory);
    }
}
function load(files, pid, alive = () => true) {
    const exports = {};
    vm.runInNewContext(source, {
        exports,
        require(name) {
            if (name === 'node:fs') return { promises: files };
            if (name === 'node:path') return path.posix;
            if (name === './shared') return { CONTROL_TIMEOUT: 150 };
            return require(name);
        },
        process: { pid, kill(target) { if (!alive(target)) throw error('ESRCH'); } },
        setTimeout(callback) { return setTimeout(callback, 1); },
        Date,
    }, { filename: modulePath });
    return exports.acquireStartupLock;
}
const lock = '/private/startup.lock';
const marker = pid => `owner.${pid}.00000000-0000-0000-0000-000000000000`;
async function absent(files) { assert.equal(files.directories.has(lock), false); }

async function main() {
    let files = new FileSystem();
    let release = await load(files, 100)('/private');
    assert.equal((await files.readdir(lock)).length, 1);
    await release(); await release(); await absent(files);
    assert.equal(files.directories.size, 1);
    console.log('Startup locks publish a complete owner and release idempotently.');

    files = new FileSystem();
    release = await load(files, 100)('/private');
    let secondEntered = false;
    const second = load(files, 101)('/private').then(value => { secondEntered = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(secondEntered, false);
    await release();
    await (await second)(); await absent(files);
    console.log('Concurrent candidates cannot enter the startup critical section together.');

    files = new FileSystem();
    files.directories.set(lock, new Set([marker(90)]));
    release = await load(files, 100, pid => pid !== 90)('/private');
    assert((await files.readdir(lock))[0].startsWith('owner.100.'));
    await release(); await absent(files);
    files.directories.set(lock, new Set());
    release = await load(files, 100)('/private');
    await release(); await absent(files);
    console.log('Dead owners and crashes after removing the owner marker recover automatically.');

    files = new FileSystem();
    const old = marker(90);
    files.directories.set(lock, new Set([old]));
    const lateEntered = deferred();
    const allowLate = deferred();
    let unlinkCalls = 0;
    files.onUnlink = async file => {
        if (file === path.posix.join(lock, old) && ++unlinkCalls === 1) {
            lateEntered.resolve(); await allowLate.promise;
        }
    };
    const late = load(files, 100, pid => pid !== 90)('/private');
    await lateEntered.promise;
    const winner = await load(files, 101, pid => pid !== 90)('/private');
    allowLate.resolve();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert((await files.readdir(lock))[0].startsWith('owner.101.'));
    await winner();
    await (await late)(); await absent(files);
    console.log('A late reaper cannot delete a new owner after losing the old marker.');

    files = new FileSystem();
    const removing = deferred();
    const allowRmdir = deferred();
    let held = false;
    files.onRmdir = async directory => {
        if (directory === lock && !held) { held = true; removing.resolve(); await allowRmdir.promise; }
    };
    const first = await load(files, 100)('/private');
    const closing = first();
    await removing.promise;
    const newer = await load(files, 101)('/private');
    allowRmdir.resolve();
    await closing;
    assert((await files.readdir(lock))[0].startsWith('owner.101.'));
    await newer(); await absent(files);
    console.log('Late rmdir cannot remove a newly published nonempty directory.');

    files = new FileSystem();
    files.directories.set(lock, new Set([marker(90)]));
    await assert.rejects(load(files, 100, () => true)('/private'), /startup is busy/);
    assert.deepEqual(await files.readdir(lock), [marker(90)]);
    assert.equal(files.directories.size, 2);
    console.log('Live or reused PIDs are never evicted by elapsed time; failed candidates clean themselves.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
