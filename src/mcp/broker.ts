import * as net from 'node:net';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CancellationToken } from 'vscode';
import type { ToolRegistry } from '../lmtools/registry';
import { startMcpServer, RunningMcpServer } from './server';
import { RpcPeer } from './rpc';
import {
    BROKER_PROTOCOL, CONTROL_TIMEOUT, MEMBER_TIMEOUT, HEARTBEAT_INTERVAL,
    ipcAddress, controlKey, connectPeer, Registration, BrokerConfiguration, BrokerEndpoint, FileCandidate, Invocation, OutputRegistration,
} from './shared';
import { BrokerOutput } from './output';
import { acquireStartupLock } from './startup';
import { Messages } from '../shared/messages';

interface Worker { peer: RpcPeer; id: string; key: string; lastSeen: number }
interface OutputLease {
    worker: Worker;
    keys: Set<string>;
    writer: BrokerOutput;
    abort: AbortController;
    peer?: RpcPeer;
}
function sameSecret(left: unknown, right: string): boolean {
    if (typeof left !== 'string') return false;
    const bytes = Buffer.from(left);
    const expected = Buffer.from(right);
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}
function normalized(file: string): string {
    const value = path.resolve(file);
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
async function outputKeys(file: string): Promise<string[]> {
    let current = path.resolve(file);
    const suffix: string[] = [];
    for (;;) {
        try {
            const real = await fs.realpath(current);
            const keys = ['path:' + normalized(path.join(real, ...suffix))];
            if (!suffix.length) {
                const stat = await fs.stat(current, { bigint: true });
                if (stat.ino !== 0n) keys.push(`file:${stat.dev}:${stat.ino}`);
            }
            return keys;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            suffix.unshift(path.basename(current));
            current = parent;
        }
    }
}

export async function runBroker(directory: string): Promise<void> {
    const secret = await controlKey(directory);
    const address = ipcAddress(directory);
    const workers = new Map<string, Worker>();
    const sockets = new Set<RpcPeer>();
    const outputs = new Map<string, string>();
    const outputClaims = new Map<string, OutputLease>();
    let http: RunningMcpServer | undefined;
    let configuration: BrokerConfiguration | undefined;
    let registry: ToolRegistry | undefined;
    let signature: string | undefined;
    let queue = Promise.resolve();
    let terminating = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let actualPort: number | undefined;
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
        const result = queue.then(fn);
        queue = result.then(() => {}, () => {});
        return result;
    };
    const endpoint = (worker: Worker): BrokerEndpoint => {
        if (!http) throw new Error(Messages.mcp.unavailable);
        return { url: http.url, authorization: http.authorization, windowKey: worker.key, pid: process.pid };
    };
    const chooseWorker = async (input: Record<string, unknown>, windowId?: string): Promise<Worker> => {
        if (windowId) {
            const worker = workers.get(windowId);
            if (!worker) throw new Error('The originating GAP window is no longer available.');
            return worker;
        }
        const available = [...workers.values()];
        if (!available.length) throw new Error('No trusted GAP window is available.');
        if (typeof input.filePath !== 'string') return available[0];
        const candidates = (await Promise.all(available.map(async worker => {
            try {
                const candidate = await worker.peer.request<FileCandidate>('locate', { filePath: input.filePath }, undefined, CONTROL_TIMEOUT);
                return { worker, ...candidate };
            } catch { return undefined; }
        }))).filter((value): value is FileCandidate & { worker: Worker } => !!value);
        const rooted = candidates.filter(candidate => candidate.root !== undefined);
        const sorted = rooted.sort((a, b) => b.root!.length - a.root!.length);
        let selected = sorted[0];
        if (selected && sorted[1]?.root?.length === selected.root!.length) {
            throw new Error('The file matches multiple GAP windows. Use the window-provided MCP connection.');
        }
        if (!selected) {
            const opened = candidates.filter(candidate => candidate.open);
            if (opened.length > 1) throw new Error('The file is open in multiple GAP windows. Use a window-provided connection.');
            selected = opened[0] ?? candidates[0];
        }
        if (!selected) throw new Error('No responsive GAP window is available.');
        if (candidates.some(candidate => candidate.dirty && candidate.worker !== selected.worker)) {
            throw new Error("Another GAP window has unsaved changes to this file. Use that window's MCP connection.");
        }
        return selected.worker;
    };
    const execute = async (name: string, input: object, token: CancellationToken, windowId?: string): Promise<object> => {
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) abort.abort();
        let outputClaimId: string | undefined;
        try {
            const args = input as Record<string, unknown>;
            const worker = await chooseWorker(args, windowId);
            if (abort.signal.aborted) throw new Error('Canceled');
            if (name === 'run_gap_file' && typeof args.outputPath === 'string' && path.isAbsolute(args.outputPath)) {
                const keys = await outputKeys(args.outputPath);
                if (keys.some(key => outputs.has(key))) throw new Error(Messages.tools.runOutputBusy);
                const id = outputClaimId = randomUUID();
                const lease: OutputLease = {
                    worker, keys: new Set(keys), abort,
                    writer: new BrokerOutput(args.outputPath, args.filePath as string, identity => {
                        const owner = outputs.get(identity);
                        if (owner !== undefined && owner !== id) throw new Error(Messages.tools.runOutputBusy);
                        outputs.set(identity, id);
                        lease.keys.add(identity);
                    }),
                };
                outputClaims.set(id, lease);
                for (const key of keys) outputs.set(key, id);
            }
            const result = await worker.peer.request<object>('execute', { name, input: args, outputClaimId } satisfies Invocation, abort.signal);
            if (abort.signal.aborted) throw new Error('Canceled');
            return result;
        } finally {
            try {
                const lease = outputClaimId ? outputClaims.get(outputClaimId) : undefined;
                if (lease) {
                    // Closing seals immediately, then drains open/truncate/write before releasing any key.
                    const closing = lease.writer.close();
                    lease.peer?.close();
                    try { await closing; }
                    finally {
                        for (const key of lease.keys) if (outputs.get(key) === outputClaimId) outputs.delete(key);
                        outputClaims.delete(outputClaimId!);
                    }
                }
            } finally { subscription.dispose(); }
        }
    };
    const configure = async (next: BrokerConfiguration): Promise<void> => {
        if (!Number.isInteger(next.port) || next.port < 0 || next.port > 65535
            || typeof next.token !== 'string' || !/^[0-9a-f]{64}$/.test(next.token)
            || typeof next.credentialKey !== 'string' || !Number.isFinite(next.revision)) throw new Error('Invalid GAP MCP configuration.');
        if (configuration && next.revision < configuration.revision) throw new Error('GAP MCP credentials changed. Retry with current credentials.');
        if (http && configuration?.port === next.port && configuration.token === next.token) return;
        const port = next.port === 0 && configuration?.port === 0 ? actualPort ?? 0 : next.port;
        await http?.close();
        http = undefined;
        configuration = next;
        if (!registry || !workers.size) return;
        http = await startMcpServer(registry, () => !terminating && workers.size > 0, () => { void shutdown(); }, next.token, port, {
            execute,
            isCurrent: async () => (await Promise.all([...workers.values()].map(worker =>
                worker.peer.request<boolean>('current', null, undefined, CONTROL_TIMEOUT).catch(() => false)))).some(Boolean),
            resolveWindow: key => {
                if (key === null) return undefined;
                const worker = [...workers.values()].find(value => sameSecret(key, value.key));
                if (!worker) throw new Error('Unknown GAP window.');
                return worker.id;
            },
        });
        actualPort = Number(new URL(http.url).port);
        for (const worker of workers.values()) {
            void worker.peer.request('endpoint', endpoint(worker), undefined, CONTROL_TIMEOUT).catch(() => worker.peer.close());
        }
    };
    const idleSoon = (delay = 1000): void => {
        if (idle) clearTimeout(idle);
        if (!workers.size) idle = setTimeout(() => { if (!workers.size) void shutdown(); }, delay);
    };
    const remove = (worker: Worker): void => {
        if (workers.get(worker.id) === worker) workers.delete(worker.id);
        idleSoon();
    };
    const server = net.createServer(socket => {
        const peer = new RpcPeer(socket);
        sockets.add(peer);
        let worker: Worker | undefined;
        let output: OutputLease | undefined;
        let finishedOutput = false;
        const handshakeTimer = setTimeout(() => { if (!worker && !output) peer.close(); }, CONTROL_TIMEOUT);
        peer.onClose = () => {
            clearTimeout(handshakeTimer);
            sockets.delete(peer);
            if (output) {
                void output.writer.close().catch(() => {});
                if (!finishedOutput) output.abort.abort();
            }
            if (worker) {
                for (const lease of outputClaims.values()) if (lease.worker === worker) {
                    void lease.writer.close().catch(() => {});
                    lease.peer?.close();
                }
                remove(worker);
            }
        };
        peer.handler = async (method, value) => {
            if (terminating) throw new Error('GAP MCP is stopping.');
            if (output) {
                if (method === 'truncate') { await output.writer.truncate(); return null; }
                if (method === 'write') { await output.writer.write(value); return null; }
                if (method === 'finish') {
                    finishedOutput = true;
                    await output.writer.close();
                    return null;
                }
                throw new Error('Unknown GAP output method.');
            }
            if (!worker) {
                if (method === 'output') {
                    const registration = value as Partial<OutputRegistration> | null;
                    if (!registration || !sameSecret(registration.control, secret)
                        || typeof registration.invocationId !== 'string' || typeof registration.path !== 'string'
                        || typeof registration.sourcePath !== 'string'
                        || [registration.identity, registration.sourceIdentity].some(identity => identity !== undefined
                            && (typeof identity !== 'string' || !/^file:\d+:[1-9]\d*$/.test(identity)))) {
                        throw new Error('Invalid GAP output registration.');
                    }
                    const lease = outputClaims.get(registration.invocationId);
                    if (!lease || lease.peer || lease.worker.peer.closed) throw new Error('The GAP invocation is no longer available.');
                    output = lease;
                    lease.peer = peer;
                    clearTimeout(handshakeTimer);
                    await lease.writer.open(registration as OutputRegistration);
                    return null;
                }
                const registration = value as Registration;
                if (method !== 'join' || !registration || !sameSecret(registration.control, secret)) throw new Error('Invalid GAP MCP control credential.');
                if (registration.protocol !== BROKER_PROTOCOL || typeof registration.windowId !== 'string'
                    || !Array.isArray(registration.tools) || typeof registration.version !== 'string') throw new Error('Incompatible GAP MCP service. Reload the windows.');
                const nextSignature = JSON.stringify([registration.version, registration.tools]);
                if (signature && signature !== nextSignature) throw new Error('GAP extension versions differ. Reload all windows using this Profile.');
                if (workers.has(registration.windowId)) throw new Error('GAP window is already registered.');
                signature = nextSignature;
                registry ??= {
                    version: registration.version,
                    forEach: visit => {
                        for (const tool of registration.tools) visit({ ...tool, tool: {
                            execute: async () => { throw new Error('Missing GAP worker'); },
                            invoke: async () => { throw new Error('Missing GAP worker'); },
                        } });
                    },
                    dispose() {}, close: async () => {},
                };
                worker = { peer, id: registration.windowId, key: randomBytes(32).toString('hex'), lastSeen: Date.now() };
                workers.set(worker.id, worker);
                clearTimeout(handshakeTimer);
                if (idle) clearTimeout(idle);
                try {
                    await serialize(() => configure(registration.configuration));
                    return endpoint(worker);
                } catch (error) { remove(worker); worker = undefined; throw error; }
            }
            worker.lastSeen = Date.now();
            if (method === 'ping') return null;
            if (method === 'configure') {
                await serialize(() => configure(value as BrokerConfiguration));
                return endpoint(worker);
            }
            if (method === 'leave') {
                remove(worker);
                worker = undefined;
                await serialize(async () => {
                    if (!workers.size) { await http?.close(); http = undefined; }
                });
                return null;
            }
            throw new Error('Unknown GAP MCP control method.');
        };
    });
    const monitor = setInterval(() => {
        for (const worker of workers.values()) if (Date.now() - worker.lastSeen > MEMBER_TIMEOUT) worker.peer.close();
    }, HEARTBEAT_INTERVAL);
    const shutdown = async (): Promise<void> => {
        if (terminating) return;
        terminating = true;
        clearInterval(monitor);
        if (idle) clearTimeout(idle);
        for (const peer of sockets) peer.close();
        await http?.close();
        await Promise.allSettled([...outputClaims.values()].map(lease => lease.writer.close()));
        await new Promise<void>(resolve => server.close(() => resolve()));
    };
    let releaseStartup: (() => Promise<void>) | undefined;
    try {
        if (process.platform !== 'win32') {
            releaseStartup = await acquireStartupLock(directory);
            try {
                const existing = await connectPeer(address);
                existing.close();
                clearInterval(monitor);
                return;
            } catch (error) {
                if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            }
            try {
                const stat = await fs.lstat(address);
                if (!stat.isSocket()) throw new Error('The GAP MCP socket path is not a socket.');
                await fs.unlink(address);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(address, () => { server.removeListener('error', reject); resolve(); });
        });
        server.on('error', () => { void shutdown(); });
        idleSoon(CONTROL_TIMEOUT);
    } catch (error) {
        clearInterval(monitor);
        server.close();
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    } finally { await releaseStartup?.(); }
}

if (require.main === module) {
    void runBroker(process.argv[2]).catch(() => { process.exitCode = 1; });
}
