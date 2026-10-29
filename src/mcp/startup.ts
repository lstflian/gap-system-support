import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { CONTROL_TIMEOUT } from './shared';

function code(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

async function removeEmpty(directory: string): Promise<void> {
    try { await fs.rmdir(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error; }
}

/** Publish an already nonempty directory: late cleanup can never remove a new owner's lock. */
export async function acquireStartupLock(directory: string): Promise<() => Promise<void>> {
    const lock = path.join(directory, 'startup.lock');
    const candidate = await fs.mkdtemp(path.join(directory, 'startup-'));
    const owner = `owner.${process.pid}.${randomUUID()}`;
    let published = false;
    try {
        await fs.writeFile(path.join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
        const deadline = Date.now() + CONTROL_TIMEOUT;
        do {
            try {
                // POSIX rename can replace an empty directory, but never another owner's nonempty one.
                await fs.rename(candidate, lock);
                published = true;
                let released = false;
                return async () => {
                    if (released) return;
                    released = true;
                    try { await fs.unlink(path.join(lock, owner)); }
                    catch (error) { if (code(error) !== 'ENOENT') throw error; else return; }
                    await removeEmpty(lock);
                };
            } catch (error) {
                if (!['EEXIST', 'ENOTEMPTY'].includes(code(error) ?? '')) throw error;
            }
            let entries: string[];
            try { entries = await fs.readdir(lock); }
            catch (error) { if (code(error) === 'ENOENT') continue; throw error; }
            const match = entries.length === 1 && /^owner\.([1-9]\d*)\.[0-9a-f-]{36}$/.exec(entries[0]);
            if (match && Number.isSafeInteger(Number(match[1]))) {
                let dead = false;
                try { process.kill(Number(match[1]), 0); }
                catch (error) { if (code(error) === 'ESRCH') dead = true; }
                if (dead) {
                    let removed = false;
                    try { await fs.unlink(path.join(lock, entries[0])); removed = true; }
                    catch (error) { if (code(error) !== 'ENOENT') throw error; }
                    // A competing reaper must not rmdir after failing to delete the old unique marker.
                    if (removed) await removeEmpty(lock);
                    continue;
                }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error('GAP MCP startup is busy. Reload the window to retry.');
    } finally {
        if (!published) {
            await fs.unlink(path.join(candidate, owner)).catch(error => { if (code(error) !== 'ENOENT') throw error; });
            await removeEmpty(candidate);
        }
    }
}
