/**
 * GAP installation discovery without VS Code dependencies.
 * The extension controller and the standalone MCP server share it.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { errorCode, GapError, reportError } from '../shared/errors';
import { Messages } from '../shared/messages';

export interface GapInstallation {
    directory: string;
    executable: string;
    environmentDirectories: string[];
    docPath?: string;
    pkgPath?: string;
}

export interface Discovery {
    status: 'found' | 'notFound' | 'ambiguous';
    candidates: GapInstallation[];
    issues: { code: string; path: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstallation(value: unknown): value is GapInstallation {
    return isRecord(value) && typeof value.directory === 'string' && path.isAbsolute(value.directory)
        && typeof value.executable === 'string' && path.isAbsolute(value.executable)
        && Array.isArray(value.environmentDirectories) && value.environmentDirectories.length > 0
        && value.environmentDirectories.every(item => typeof item === 'string' && path.isAbsolute(item))
        && [value.docPath, value.pkgPath].every(item => item === undefined || (typeof item === 'string' && path.isAbsolute(item)));
}

export function gapEnvironment(value: GapInstallation, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result = { ...inherited };
    const keys = Object.keys(result).filter(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
    const key = keys[0] ?? 'PATH';
    const paths = [...value.environmentDirectories, ...keys.flatMap(name => (result[name] ?? '').split(path.delimiter))];
    const seen = new Set<string>();
    for (const name of keys) delete result[name];
    result[key] = paths.filter(item => {
        if (!item) return false;
        const id = process.platform === 'win32' ? item.toLowerCase() : item;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    }).join(path.delimiter);
    result.NoDefaultCurrentDirectoryInExePath = '1';
    return result;
}

/** Run scripts/find-gap.js in a separate Node process so a slow scan never blocks the caller. */
export async function discoverGap(extensionRoot: string, directory?: string, signal?: AbortSignal): Promise<Discovery> {
    const script = path.join(extensionRoot, 'scripts', 'find-gap.js');
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete environment.NODE_OPTIONS;
    const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [script, ...(directory ? ['--directory', directory] : [])], {
            env: environment,
            windowsHide: true, encoding: 'utf8', signal, timeout: 15000, maxBuffer: 1024 * 1024,
        }, (error, stdout) => error ? reject(new GapError('GAP_DISCOVERY_FAILED', Messages.runtime.discoveryFailed, { cause: error })) : resolve(stdout));
    });
    const value: unknown = JSON.parse(output);
    if (!isRecord(value) || !['found', 'notFound', 'ambiguous'].includes(String(value.status))
        || !Array.isArray(value.candidates) || !value.candidates.every(isInstallation)
        || !Array.isArray(value.issues) || !value.issues.every(issue =>
            isRecord(issue) && typeof issue.code === 'string' && typeof issue.path === 'string')) {
        throw new GapError('GAP_DISCOVERY_INVALID', Messages.runtime.invalidDiscovery);
    }
    const result: Discovery = {
        status: value.candidates.length === 0 ? 'notFound' : value.candidates.length === 1 ? 'found' : 'ambiguous',
        candidates: value.candidates,
        issues: value.issues.map(issue => ({ code: String(issue.code), path: String(issue.path) })),
    };
    for (const issue of result.issues) reportError(Messages.runtime.discoveryIssue(issue.code, issue.path), 'GAP runtime');
    if (!result.candidates.length && result.issues.length) {
        throw new GapError('GAP_DISCOVERY_FAILED', Messages.runtime.discoveryIssue(result.issues[0].code, result.issues[0].path));
    }
    return result;
}

/** Whether a previously discovered installation still exists on disk. */
export async function isUsable(value: GapInstallation): Promise<boolean> {
    try {
        const files = await Promise.all([fs.stat(value.executable), ...value.environmentDirectories.map(directory => fs.stat(directory))]);
        return files[0].isFile() && files.slice(1).every(stat => stat.isDirectory());
    } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false;
        throw error;
    }
}

export function requireSingleInstallation(result: Discovery): GapInstallation {
    if (result.candidates.length === 1) return result.candidates[0];
    throw new GapError('GAP_INSTALLATION_REQUIRED', result.candidates.length > 1 ? Messages.runtime.ambiguous : Messages.runtime.notFound);
}

/** Non-interactive resolution for processes without a VS Code window. */
export class StandaloneGapInstallation {
    private cache: GapInstallation | undefined;
    private pending: Promise<GapInstallation> | undefined;

    constructor(private readonly extensionRoot: string, private readonly selected: string | undefined) {}

    async resolve(): Promise<GapInstallation> {
        const cached = this.cache;
        if (cached && await isUsable(cached)) return cached;
        if (this.cache === cached) this.cache = undefined;
        this.pending ??= discoverGap(this.extensionRoot, this.selected)
            .then(requireSingleInstallation)
            .finally(() => { this.pending = undefined; });
        const value = await this.pending;
        this.cache = value;
        return value;
    }
}
