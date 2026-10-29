import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ToolRegistry, ToolEntry } from '../lmtools/registry';
import type { RunningMcpServer } from './server';
import type { RpcPeer } from './rpc';
import {
    privateDirectory, controlKey, connectBroker, BROKER_PROTOCOL, CONTROL_TIMEOUT, HEARTBEAT_INTERVAL,
    Registration, ToolDescription, BrokerConfiguration, BrokerEndpoint, FileCandidate, Invocation, OutputRegistration,
    connectPeer, ipcAddress, OUTPUT_CHUNK_SIZE,
} from './shared';

export interface SharedMcpConnection extends RunningMcpServer {
    readonly headers: Record<string, string>;
    readonly pid: number;
    configure(configuration: BrokerConfiguration): Promise<void>;
}

function normalized(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function locate(filePath: string): Promise<FileCandidate> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return { open: false, dirty: false };
    const uri = vscode.Uri.file(filePath);
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file');
    const exact = documents.filter(document => normalized(document.uri.fsPath) === normalized(filePath));
    const others = documents.filter(document => normalized(document.uri.fsPath) !== normalized(filePath));
    if (!others.length) return { root, open: exact.length > 0, dirty: exact.some(document => document.isDirty) };
    let real: string;
    let identity: Awaited<ReturnType<typeof fs.stat>>;
    try { [real, identity] = await Promise.all([fs.realpath(filePath), fs.stat(filePath, { bigint: true })]); }
    catch { return { root, open: exact.length > 0, dirty: exact.some(document => document.isDirty) }; }
    const aliases = await Promise.all(others.map(async document => {
        try {
            const [target, stat] = await Promise.all([fs.realpath(document.uri.fsPath), fs.stat(document.uri.fsPath, { bigint: true })]);
            return normalized(target) === normalized(real)
                || (identity.ino !== 0n && stat.dev === identity.dev && stat.ino === identity.ino) ? document : undefined;
        } catch { return undefined; }
    }));
    const matched = [...exact, ...aliases.filter((value): value is vscode.TextDocument => !!value)];
    return { root, open: matched.length > 0, dirty: matched.some(document => document.isDirty) };
}

export async function joinMcpService(
    registry: ToolRegistry,
    storage: string,
    instanceId: string,
    configuration: BrokerConfiguration,
    isCurrent: () => boolean,
    onChanged: () => void,
    onClosed: () => void,
): Promise<SharedMcpConnection> {
    const directory = await privateDirectory(storage, instanceId);
    const control = await controlKey(directory);
    if (!isCurrent()) throw new vscode.CancellationError();
    const peer = await connectBroker(directory);
    let accepting = true;
    let stopped = false;
    let endpoint: BrokerEndpoint | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const invocations = new Set<vscode.CancellationTokenSource>();
    const completions = new Set<Promise<unknown>>();
    const outputPeers = new Set<RpcPeer>();
    const entries = new Map<string, ToolEntry<object, object>>();
    const tools: ToolDescription[] = [];
    registry.forEach(entry => {
        entries.set(entry.metadata.name, entry as ToolEntry<object, object>);
        tools.push({ metadata: entry.metadata, annotations: entry.annotations });
    });
    const stopAccepting = (): void => {
        accepting = false;
        for (const invocation of invocations) invocation.cancel();
    };
    peer.onClose = () => {
        stopAccepting();
        for (const output of outputPeers) output.close();
        if (heartbeat) clearInterval(heartbeat);
        if (!stopped) onClosed();
    };
    peer.handler = async (method, data, signal) => {
        if (method === 'endpoint') {
            const next = data as BrokerEndpoint;
            if (!next || typeof next.url !== 'string' || typeof next.authorization !== 'string'
                || typeof next.windowKey !== 'string' || !Number.isInteger(next.pid)) throw new Error('Invalid GAP endpoint.');
            endpoint = next;
            onChanged();
            return null;
        }
        if (method === 'current') return accepting && isCurrent();
        if (!accepting || !isCurrent()) throw new Error('This GAP window is no longer available.');
        if (method === 'locate') return locate((data as { filePath: string }).filePath);
        if (method !== 'execute') throw new Error('Unknown GAP worker method.');
        const invocation = data as Invocation;
        const entry = entries.get(invocation?.name);
        if (!entry || !invocation.input || typeof invocation.input !== 'object') throw new Error('Unknown GAP tool.');
        const cancellation = new vscode.CancellationTokenSource();
        const cancel = (): void => cancellation.cancel();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        invocations.add(cancellation);
        let outputPeer: RpcPeer | undefined;
        const execution = (async () => {
            if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
            const output = await entry.tool.execute(invocation.input, cancellation.token, invocation.outputClaimId ? {
                openOutput: async identity => {
                    // Per-run output transport keeps log backpressure off the control connection.
                    const stream = await connectPeer(ipcAddress(directory));
                    outputPeer = stream;
                    outputPeers.add(stream);
                    stream.onClose = () => { outputPeers.delete(stream); };
                    try {
                        if (peer.closed || cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
                        await stream.request('output', {
                            ...identity, control, invocationId: invocation.outputClaimId!,
                        } satisfies OutputRegistration);
                        let writes = Promise.resolve();
                        let closing: Promise<void> | undefined;
                        return {
                            async truncate() { await stream.request('truncate', null); },
                            write(chunk) {
                                const next = writes.then(async () => {
                                    for (let offset = 0; offset < chunk.length; offset += OUTPUT_CHUNK_SIZE) {
                                        await stream.request('write', chunk.subarray(offset, offset + OUTPUT_CHUNK_SIZE).toString('base64'));
                                    }
                                });
                                writes = next;
                                return next;
                            },
                            close() {
                                closing ??= (async () => {
                                    try {
                                        await writes.catch(() => {});
                                        // Cleanup remains possible after the execution's AbortSignal is canceled.
                                        await stream.request('finish', null);
                                    } finally { stream.close(); }
                                })();
                                return closing;
                            },
                        };
                    } catch (error) { stream.close(); throw error; }
                },
            } : undefined);
            if (cancellation.token.isCancellationRequested || !isCurrent()) throw new vscode.CancellationError();
            return output;
        })();
        completions.add(execution);
        try { return await execution; }
        finally {
            outputPeer?.close();
            signal.removeEventListener('abort', cancel);
            invocations.delete(cancellation);
            cancellation.dispose();
            completions.delete(execution);
        }
    };
    try {
        endpoint = await peer.request<BrokerEndpoint>('join', {
            control, protocol: BROKER_PROTOCOL, windowId: randomUUID(), version: registry.version, tools, configuration,
        } satisfies Registration, undefined, CONTROL_TIMEOUT);
        if (!isCurrent()) throw new vscode.CancellationError();
        heartbeat = setInterval(() => {
            void peer.request('ping', null, undefined, CONTROL_TIMEOUT).catch(() => peer.close());
        }, HEARTBEAT_INTERVAL);
        heartbeat.unref();
        return {
            get url() { return endpoint!.url; },
            get authorization() { return endpoint!.authorization; },
            get headers() { return { Authorization: endpoint!.authorization, 'x-gap-window': endpoint!.windowKey }; },
            get pid() { return endpoint!.pid; },
            stopAccepting,
            async configure(next) {
                endpoint = await peer.request<BrokerEndpoint>('configure', next, undefined, CONTROL_TIMEOUT);
                onChanged();
            },
            async close() {
                if (stopped) return;
                stopped = true;
                stopAccepting();
                if (heartbeat) clearInterval(heartbeat);
                await Promise.allSettled([...completions]);
                try {
                    if (!peer.closed) await peer.request('leave', null, undefined, CONTROL_TIMEOUT);
                } finally { peer.close(); }
            },
        };
    } catch (error) {
        stopped = true;
        stopAccepting();
        peer.close();
        throw error;
    }
}
