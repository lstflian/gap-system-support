import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import type { ToolMetadata, ToolEntry, ToolOutputIdentity } from '../lmtools/registry';
import { RpcPeer } from './rpc';

export const BROKER_PROTOCOL = 3;
export const OUTPUT_CHUNK_SIZE = 64 * 1024;
export const CONTROL_TIMEOUT = 10000;
export const HEARTBEAT_INTERVAL = 2000;
export const MEMBER_TIMEOUT = 15000;
export interface ToolDescription { metadata: ToolMetadata; annotations?: ToolEntry<object, object>['annotations'] }
export interface BrokerConfiguration { port: number; token: string; credentialKey: string; revision: number }
export interface BrokerEndpoint { url: string; authorization: string; windowKey: string; pid: number }
export interface Registration {
    control: string;
    protocol: number;
    windowId: string;
    version: string;
    tools: ToolDescription[];
    configuration: BrokerConfiguration;
}
export interface FileCandidate { root?: string; open: boolean; dirty: boolean }
export interface Invocation { name: string; input: Record<string, unknown>; outputClaimId?: string }
export interface OutputRegistration extends ToolOutputIdentity { control: string; invocationId: string }

export function ipcAddress(directory: string): string {
    const hash = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 40);
    return process.platform === 'win32' ? `\\\\.\\pipe\\gap-mcp-${hash}`
        : path.join(directory, 'broker.sock');
}

export async function privateDirectory(storage: string, instanceId: string): Promise<string> {
    await fs.mkdir(storage, { recursive: true });
    const canonical = await fs.realpath(storage);
    const hash = createHash('sha256').update(canonical + '\0' + instanceId).digest('hex').slice(0, 32);
    const directory = process.platform === 'win32' ? path.join(storage, 'mcp', hash)
        : path.join(os.tmpdir(), `gap-mcp-${process.getuid?.() ?? 'user'}-${hash}`);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('GAP MCP storage is not owned by this user.');
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
    return directory;
}

export async function controlKey(directory: string): Promise<string> {
    const keyPath = path.join(directory, 'control.key');
    const temporary = path.join(directory, randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        try { await fs.link(temporary, keyPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await fs.rm(temporary, { force: true }); }
    const key = await fs.readFile(keyPath, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid GAP MCP control credential.');
    return key;
}

export function connectPeer(address: string): Promise<RpcPeer> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(address);
        const timer = setTimeout(() => socket.destroy(new Error('GAP MCP connection timed out.')), CONTROL_TIMEOUT);
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('connect', () => { clearTimeout(timer); resolve(new RpcPeer(socket)); });
    });
}

export async function connectBroker(directory: string): Promise<RpcPeer> {
    const address = ipcAddress(directory);
    try { return await connectPeer(address); }
    catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // The binding process owns Unix socket recovery, including any delayed detached candidate.
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete environment.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(__dirname, 'broker.js'), directory], {
        detached: true, windowsHide: true, stdio: 'ignore', env: environment,
    });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + CONTROL_TIMEOUT;
    do {
        if (spawnError) throw spawnError;
        await new Promise(resolve => setTimeout(resolve, 50));
        try { return await connectPeer(address); }
        catch (error) {
            if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
    } while (Date.now() < deadline);
    throw new Error('GAP MCP background service did not start. Reload the window to retry.');
}
