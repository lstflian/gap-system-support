import { spawn, execFile, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs, constants, BigIntStats, createWriteStream } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import * as vscode from 'vscode';
import { isBashOnWindows, quoteShellPath, toRuntimePath } from '../path';
import { throwIfToolCancelled } from '../lmtools/toolCore';
import { getErrorMessage, Messages } from './messages';

interface WslTarget {
    executable: string;
    args: string[];
}

export interface GapLaunch {
    executable: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
    protocol?: { marker: string; wsl?: WslTarget };
}

function isMissing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function pathKey(value: string): string {
    const resolved = path.resolve(value);
    return `path:${os.platform() === 'win32' ? resolved.toLowerCase() : resolved}`;
}

function fileKey(stat: BigIntStats): string | undefined {
    return stat.ino === 0n ? undefined : `file:${stat.dev}:${stat.ino}`;
}

async function statIfPresent(file: string): Promise<BigIntStats | undefined> {
    try {
        return await fs.stat(file, { bigint: true });
    } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
    }
}

async function findGap(cwd: string | undefined): Promise<string> {
    const windows = os.platform() === 'win32';
    const envPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
    const extensions = windows
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.(exe|com|bat|cmd)$/i.test(ext))
        : [''];
    for (const directory of envPath.split(path.delimiter)) {
        if (!directory) continue;
        for (const extension of extensions) {
            const candidate = path.resolve(cwd ?? process.cwd(), directory.replace(/^"|"$/g, ''), `gap${extension}`);
            try {
                if (!(await fs.stat(candidate)).isFile()) continue;
                await fs.access(candidate, windows ? constants.F_OK : constants.X_OK);
                return candidate;
            } catch (error) {
                if (isMissing(error) || (error instanceof Error && 'code' in error && error.code === 'EACCES')) continue;
                throw error;
            }
        }
    }
    throw new Error(Messages.tools.runNotFound);
}

export function nativeGapLaunch(executable: string, filePath: string, platform: NodeJS.Platform): GapLaunch {
    if (platform !== 'win32' || !/\.(bat|cmd)$/i.test(executable)) {
        return { executable, args: ['--nointeract', '*stdin*', filePath] };
    }
    const launcher = quoteShellPath(executable);
    const file = quoteShellPath(filePath);
    if (!launcher || !file) throw new Error(Messages.extension.unsafeShellPath(!launcher ? executable : filePath));
    return {
        executable: process.env.ComSpec || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
        args: ['/d', '/v:off', '/s', '/c', `"${launcher} --nointeract "*stdin*" ${file}"`],
        windowsVerbatimArguments: true,
    };
}

function posixQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

export function shellGapLaunch(
    shell: string, filePath: string, marker: string, wsl?: WslTarget, cwd?: string,
): GapLaunch {
    const command = [
        cwd ? `cd ${posixQuote(cwd)} || exit 1;` : '',
        `exec gap --nointeract '*stdin*' ${posixQuote(filePath)} 1>&3 3>&-`,
    ].join(' ');
    // Keep the output pipe across shell startup so only GAP can confirm that it started.
    const script = `exec 3>&1; printf '${marker}:pid:%s\\n' "$$" >&3; ` +
        `exec "\${SHELL:-/bin/sh}" -ic ${posixQuote(`exec /bin/sh -c ${posixQuote(command)}`)} 1>&2`;
    const killArgs = wsl?.args.filter((arg, index, args) =>
        arg !== '--cd' && !arg.startsWith('--cd=') && args[index - 1] !== '--cd');
    return {
        executable: shell,
        args: wsl ? [...wsl.args, '--exec', 'setsid', 'sh', '-c', script] : ['-c', script],
        protocol: { marker, wsl: wsl ? { executable: wsl.executable, args: killArgs ?? [] } : undefined },
    };
}

function wslProfileArgs(): string[] {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const profile = config.get<string>('defaultProfile.windows');
    const profiles = config.get<Record<string, { args?: unknown } | null>>('profiles.windows');
    const args = profile ? profiles?.[profile]?.args : undefined;
    if (args === undefined) return [];
    if (!Array.isArray(args) || !args.every((value): value is string => typeof value === 'string')
        || args.some(arg => ['-e', '--exec', '--', '--shell-type'].includes(arg))) {
        throw new Error(Messages.tools.runInvalidShellArgs);
    }
    return args;
}

async function resolveLaunch(filePath: string, uri: vscode.Uri, cwd: string | undefined): Promise<GapLaunch> {
    const platform = os.platform();
    const shell = vscode.env.shell;
    const runtimePath = toRuntimePath(filePath, uri);
    if (platform === 'win32' && /(?:^|[\\/])(?:wsl|bash)(?:\.exe)?$/i.test(shell)) {
        const wsl = isBashOnWindows()
            ? {
                executable: /(?:^|[\\/])wsl(?:\.exe)?$/i.test(shell)
                    ? shell : path.win32.join(path.win32.dirname(shell), 'wsl.exe'),
                args: /(?:^|[\\/])wsl(?:\.exe)?$/i.test(shell) ? wslProfileArgs() : [],
            }
            : undefined;
        return shellGapLaunch(wsl?.executable ?? shell, runtimePath, randomBytes(16).toString('hex'), wsl,
            cwd ? toRuntimePath(cwd, uri) : undefined);
    }
    return nativeGapLaunch(await findGap(cwd), runtimePath, platform);
}

function runCommand(executable: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(executable, args, { windowsHide: true }, error => error ? reject(error) : resolve());
    });
}

function taskkill(pid: number): Promise<void> {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    return runCommand(executable, ['/PID', String(pid), '/T', '/F']);
}

function waitForWslPid(pid: Promise<number | undefined>): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(Messages.tools.runWslCancelFailed)), 5000);
        pid.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

async function terminate(
    child: ChildProcess, launch: GapLaunch, targetPid: Promise<number | undefined>, hasClosed: () => boolean,
): Promise<void> {
    if (hasClosed() || child.pid === undefined) return;
    if (launch.protocol?.wsl) {
        try {
            const pid = await waitForWslPid(targetPid);
            if (pid !== undefined) {
                const target = launch.protocol.wsl;
                await runCommand(target.executable, [...target.args, '--exec', '/bin/kill', '-KILL', '--', `-${pid}`]);
            }
        } catch (error) {
            if (!hasClosed()) {
                await taskkill(child.pid);
                throw error;
            }
        }
    }
    if (hasClosed()) return;
    if (os.platform() === 'win32') {
        try {
            await taskkill(child.pid);
        } catch (error) {
            if (!hasClosed()) throw error;
        }
    } else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        }
    }
}

function execute(launch: GapLaunch, fd: number, cwd: string | undefined, token: vscode.CancellationToken): Promise<void> {
    throwIfToolCancelled(token);
    return new Promise((resolve, reject) => {
        const child = spawn(launch.executable, launch.args, {
            cwd,
            stdio: ['pipe', 'pipe', fd],
            detached: os.platform() !== 'win32',
            windowsHide: true,
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
            env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
        });
        let closed = false;
        let failure: Error | undefined;
        const marker = Buffer.from(`GAP_RUN_READY_${randomBytes(16).toString('hex')}`);
        let ready = false;
        let targetPid: number | undefined;
        let reportPid!: (pid: number | undefined) => void;
        const pid = new Promise<number | undefined>(resolve => { reportPid = resolve; });
        let stopping: Promise<void> | undefined;
        const stop = (): void => {
            stopping ??= terminate(child, launch, pid, () => closed).catch(error => {
                failure = error instanceof Error ? error : new Error(getErrorMessage(error));
                if (!closed) child.kill();
            });
        };
        const cancellation = token.onCancellationRequested(stop);
        if (token.isCancellationRequested) stop();
        async function* filterOutput(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
            let pending = Buffer.alloc(0);
            let needsPid = launch.protocol !== undefined;
            for await (const chunk of chunks) {
                if (ready) {
                    yield chunk;
                    continue;
                }
                pending = Buffer.concat([pending, chunk]);
                if (needsPid) {
                    const end = pending.indexOf(10);
                    if (end === -1) {
                        if (pending.length > 256) throw new Error(Messages.tools.runInvalidProtocol);
                        continue;
                    }
                    const line = pending.subarray(0, end).toString('ascii').replace(/\r$/, '');
                    const prefix = `${launch.protocol?.marker}:pid:`;
                    const value = line.slice(prefix.length);
                    if (!line.startsWith(prefix) || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
                        throw new Error(Messages.tools.runInvalidProtocol);
                    }
                    targetPid = Number(value);
                    reportPid(targetPid);
                    needsPid = false;
                    pending = pending.subarray(end + 1);
                }
                const start = pending.indexOf(marker);
                if (start !== -1) {
                    ready = true;
                    yield pending.subarray(0, start);
                    yield pending.subarray(start + marker.length);
                    pending = Buffer.alloc(0);
                } else {
                    // Retain only a possible split marker, never the whole program's output.
                    const length = Math.max(0, pending.length - marker.length + 1);
                    if (length) yield pending.subarray(0, length);
                    pending = pending.subarray(length);
                }
            }
            if (pending.length) yield pending;
        }
        const stdout = child.stdout;
        const stdin = child.stdin;
        if (!stdout || !stdin) {
            failure = new Error(Messages.tools.runInvalidProtocol);
            stop();
        }
        const writing = stdout ? pipeline(stdout, filterOutput, createWriteStream('', { fd, autoClose: false }))
            .catch(error => {
                failure = error instanceof Error ? error : new Error(getErrorMessage(error));
                stop();
            }) : Promise.resolve();
        stdin?.on('error', error => {
            failure = error;
            stop();
        });
        // GAP reads this before the user's command-line file; no Read wrapper changes its semantics.
        stdin?.end(`Print("${marker.toString('ascii')}");\n`);
        child.once('error', error => { failure = error; });
        child.once('close', (_code, signal) => {
            closed = true;
            reportPid(targetPid);
            cancellation.dispose();
            void (async () => {
                await writing;
                await stopping;
                if (failure) throw failure;
                throwIfToolCancelled(token);
                if (signal) throw new Error(Messages.tools.runInterrupted(signal));
                if (!ready) throw new Error(Messages.tools.runLauncherFailed);
            })().then(resolve, reject);
        });
    });
}

export class GapRunner implements vscode.Disposable {
    private readonly outputs = new Set<string>();
    private readonly active = new Map<vscode.CancellationTokenSource, Promise<void>>();
    private disposed = false;
    private closing: Promise<void> | undefined;

    async run(filePath: string, outputPath: string, uri: vscode.Uri, cwd: string | undefined,
        token: vscode.CancellationToken): Promise<void> {
        if (this.disposed) throw new Error(Messages.tools.runClosed);
        throwIfToolCancelled(token);
        const cancellation = new vscode.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => cancellation.cancel());
        if (token.isCancellationRequested) cancellation.cancel();
        const running = this.runFile(filePath, outputPath, uri, cwd, cancellation.token);
        this.active.set(cancellation, running);
        try {
            await running;
        } finally {
            this.active.delete(cancellation);
            listener.dispose();
            cancellation.dispose();
        }
    }

    private async runFile(filePath: string, outputPath: string, uri: vscode.Uri, cwd: string | undefined,
        token: vscode.CancellationToken): Promise<void> {
        const source = await fs.stat(filePath, { bigint: true });
        if (!source.isFile()) throw new Error(Messages.tools.runInputNotFile);
        await fs.access(filePath, constants.R_OK);
        const sourcePath = pathKey(await fs.realpath(filePath));
        if (pathKey(outputPath) === sourcePath) throw new Error(Messages.tools.runSameFile);
        const launch = await resolveLaunch(filePath, uri, cwd);
        throwIfToolCancelled(token);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const existing = await statIfPresent(outputPath);
        if (existing && !existing.isFile()) throw new Error(Messages.tools.runOutputNotFile);
        const outputKey = pathKey(existing ? await fs.realpath(outputPath)
            : path.join(await fs.realpath(path.dirname(outputPath)), path.basename(outputPath)));
        const sourceKey = fileKey(source);
        if (outputKey === sourcePath || (sourceKey !== undefined && existing && fileKey(existing) === sourceKey)) {
            throw new Error(Messages.tools.runSameFile);
        }
        const claimed: string[] = [];
        const claim = (key: string): void => {
            if (this.outputs.has(key)) throw new Error(Messages.tools.runOutputBusy);
            this.outputs.add(key);
            claimed.push(key);
        };
        let output: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
            throwIfToolCancelled(token);
            claim(outputKey);
            // Check the opened file's identity before truncating it, including link aliases.
            output = await fs.open(outputPath, constants.O_WRONLY | constants.O_CREAT);
            const actual = await output.stat({ bigint: true });
            if (!actual.isFile()) throw new Error(Messages.tools.runOutputNotFile);
            const identity = fileKey(actual);
            if (identity !== undefined && identity === sourceKey) throw new Error(Messages.tools.runSameFile);
            if (identity !== undefined) claim(identity);
            throwIfToolCancelled(token);
            await output.truncate(0);
            await execute(launch, output.fd, cwd, token);
        } finally {
            try {
                await output?.close();
            } finally {
                for (const key of claimed) this.outputs.delete(key);
            }
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const invocation of this.active.keys()) invocation.cancel();
    }

    close(): Promise<void> {
        this.closing ??= (async () => {
            this.dispose();
            // Invocations report their own errors; shutdown waits for their file/process cleanup.
            await Promise.allSettled([...this.active.values()]);
        })();
        return this.closing;
    }
}
