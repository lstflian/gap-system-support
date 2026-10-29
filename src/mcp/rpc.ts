import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

const MAX_FRAME = 16 * 1024 * 1024;
type Handler = (method: string, data: unknown, signal: AbortSignal) => Promise<unknown>;
interface Reply { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }

export class RpcPeer {
    private buffer = '';
    private readonly replies = new Map<string, Reply>();
    private readonly active = new Map<string, AbortController>();
    private ended = false;
    handler: Handler = async () => { throw new Error('GAP IPC is not ready.'); };
    onClose: () => void = () => {};

    constructor(readonly socket: Socket) {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            this.buffer += chunk;
            if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.close();
            let end: number;
            while ((end = this.buffer.indexOf('\n')) >= 0) {
                const frame = this.buffer.slice(0, end);
                this.buffer = this.buffer.slice(end + 1);
                try { this.receive(JSON.parse(frame)); } catch { this.close(); return; }
            }
        });
        socket.on('error', () => this.finish());
        socket.on('close', () => this.finish());
    }

    get closed(): boolean { return this.ended; }

    private send(value: object): void {
        if (this.ended || this.socket.destroyed) throw new Error('GAP window connection closed.');
        const frame = JSON.stringify(value) + '\n';
        if (Buffer.byteLength(frame) + this.socket.writableLength > MAX_FRAME) {
            throw new Error('GAP IPC message exceeds the size limit.');
        }
        this.socket.write(frame);
    }

    request<T>(method: string, data: unknown, signal?: AbortSignal, timeout = 0): Promise<T> {
        if (signal?.aborted) return Promise.reject(new Error('Canceled'));
        return new Promise<T>((resolve, reject) => {
            const id = randomUUID();
            const cancel = (): void => {
                try { this.send({ kind: 'cancel', id }); } catch { this.close(); }
            };
            const timer = timeout ? setTimeout(() => {
                this.replies.delete(id);
                cleanup();
                cancel();
                reject(new Error(`GAP IPC ${method} timed out.`));
            }, timeout) : undefined;
            const cleanup = (): void => {
                if (timer) clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
            };
            this.replies.set(id, { resolve: value => resolve(value as T), reject, cleanup });
            signal?.addEventListener('abort', cancel, { once: true });
            try { this.send({ kind: 'call', id, method, data }); }
            catch (error) {
                this.replies.delete(id);
                cleanup();
                reject(error);
            }
        });
    }

    private receive(message: unknown): void {
        if (!message || typeof message !== 'object') throw new Error('Invalid IPC message');
        const frame = message as Record<string, unknown>;
        if (typeof frame.id !== 'string') throw new Error('Invalid IPC id');
        const id = frame.id;
        if (frame.kind === 'reply') {
            const pending = this.replies.get(id);
            if (!pending) return;
            this.replies.delete(id);
            pending.cleanup();
            if (typeof frame.error === 'string') pending.reject(new Error(frame.error));
            else pending.resolve(frame.data);
        } else if (frame.kind === 'cancel') {
            this.active.get(id)?.abort();
        } else if (frame.kind === 'call' && typeof frame.method === 'string' && !this.active.has(id)) {
            const controller = new AbortController();
            this.active.set(id, controller);
            void Promise.resolve().then(() => this.handler(frame.method as string, frame.data, controller.signal))
                .then(data => this.send({ kind: 'reply', id, data }), error => this.send({
                    kind: 'reply', id, error: error instanceof Error ? error.message : String(error),
                })).catch(() => this.close()).finally(() => this.active.delete(id));
        } else throw new Error('Invalid IPC frame');
    }

    private finish(): void {
        if (this.ended) return;
        this.ended = true;
        for (const pending of this.replies.values()) {
            pending.cleanup();
            pending.reject(new Error('GAP window connection closed.'));
        }
        this.replies.clear();
        for (const active of this.active.values()) active.abort();
        this.active.clear();
        this.onClose();
    }

    close(): void {
        this.socket.destroy();
        this.finish();
    }
}
