import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import type { ToolOutputIdentity } from '../lmtools/registry';
import { OUTPUT_CHUNK_SIZE } from './shared';
import { Messages } from '../shared/messages';

function pathKey(file: string): string {
    const absolute = path.resolve(file);
    return 'path:' + (process.platform === 'win32' ? absolute.toLowerCase() : absolute);
}

/** Only this process may mutate the file; every accepted operation precedes close. */
export class BrokerOutput {
    private file: fs.FileHandle | undefined;
    private queue = Promise.resolve();
    private sealed = false;
    private truncated = false;
    private failure: unknown;
    private closing: Promise<void> | undefined;

    constructor(private readonly outputPath: string, private readonly sourcePath: string,
        private readonly claim: (identity: string) => void) {}

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        if (this.sealed) return Promise.reject(new Error('The GAP output is closed.'));
        const next = this.queue.then(() => {
            if (this.failure) throw this.failure;
            return operation();
        });
        this.queue = next.then(() => {}, error => { this.failure = error; });
        return next;
    }

    open(expected: ToolOutputIdentity): Promise<void> {
        return this.enqueue(async () => {
            if (this.file) throw new Error('The GAP output is already open.');
            this.file = await fs.open(this.outputPath, constants.O_WRONLY | constants.O_CREAT);
            const actual = await this.file.stat({ bigint: true });
            if (!actual.isFile()) throw new Error(Messages.tools.runOutputNotFile);
            const identity = actual.ino === 0n ? undefined : `file:${actual.dev}:${actual.ino}`;
            const real = pathKey(await fs.realpath(this.outputPath));
            if (real !== expected.path || (expected.identity !== undefined && identity !== expected.identity)) {
                throw new Error('The GAP output file changed before execution. Retry the invocation.');
            }
            const source = await fs.stat(this.sourcePath, { bigint: true });
            if (real === expected.sourcePath || real === pathKey(await fs.realpath(this.sourcePath))
                || (identity !== undefined && (identity === expected.sourceIdentity
                    || (actual.dev === source.dev && actual.ino === source.ino)))) {
                throw new Error(Messages.tools.runSameFile);
            }
            // Filesystems without inode identities retain the existing canonical-path fallback.
            this.claim(real);
            if (identity !== undefined) this.claim(identity);
        });
    }

    truncate(): Promise<void> {
        return this.enqueue(async () => {
            if (!this.file || this.truncated) throw new Error('The GAP output is not ready.');
            await this.file.truncate(0);
            this.truncated = true;
        });
    }

    write(encoded: unknown): Promise<void> {
        if (typeof encoded !== 'string' || encoded.length > Math.ceil(OUTPUT_CHUNK_SIZE / 3) * 4) {
            return Promise.reject(new Error('Invalid GAP output chunk.'));
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > OUTPUT_CHUNK_SIZE || bytes.toString('base64') !== encoded) {
            return Promise.reject(new Error('Invalid GAP output chunk.'));
        }
        return this.enqueue(async () => {
            if (!this.file || !this.truncated) throw new Error('The GAP output is not ready.');
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, null);
                if (!bytesWritten) throw new Error('Could not write GAP output.');
                offset += bytesWritten;
            }
        });
    }

    close(): Promise<void> {
        // Seal synchronously, including when open/stat/write is currently awaiting filesystem IO.
        this.sealed = true;
        this.closing ??= this.queue.then(async () => {
            try { await this.file?.close(); }
            finally { this.file = undefined; }
            if (this.failure) throw this.failure;
        });
        return this.closing;
    }
}
