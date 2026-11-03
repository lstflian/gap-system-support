/**
 * The VS Code window as a tool host: open editors, workspace trust and window settings.
 */

import { BigIntStats, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HelpDataContext } from '../../help/helpData';
import { getRunCwd } from '../../path';
import type { RunEnvironment } from '../../runtime/contracts';
import { resolveGapInstallation } from '../../runtime/installation';
import { defaultWindowsProfileArgs } from '../../runtime/terminal';
import { errorCode } from '../../shared/errors';
import { Messages } from '../../shared/messages';
import type { ToolHost } from '../contracts';
import { throwIfToolCancelled, ToolError } from '../core/toolCore';
import { createToolRegistry, ToolRegistry } from '../registry';

function comparablePath(value: string): string {
    const resolved = path.resolve(value);
    return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

interface FileIdentity {
    realPath: string;
    stat: BigIntStats;
}

async function fileIdentity(filePath: string): Promise<FileIdentity> {
    const [realPath, stat] = await Promise.all([fs.realpath(filePath), fs.stat(filePath, { bigint: true })]);
    return { realPath: comparablePath(realPath), stat };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
    return left.realPath === right.realPath
        || (left.stat.ino !== 0n && left.stat.dev === right.stat.dev && left.stat.ino === right.stat.ino);
}

/** Find a modified editor for filePath, including one opened through a link or another spelling. */
async function modifiedSource(filePath: string, token: vscode.CancellationToken): Promise<vscode.TextDocument | undefined> {
    const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && document.isDirty);
    const exact = documents.find(document => comparablePath(document.uri.fsPath) === comparablePath(filePath));
    if (exact || !documents.length) return exact;
    const input = await fileIdentity(filePath);
    for (const document of documents) {
        throwIfToolCancelled(token);
        let identity: FileIdentity;
        try {
            identity = await fileIdentity(document.uri.fsPath);
        } catch (error) {
            // An unrelated open document may have been deleted since it was opened.
            if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
            throw error;
        }
        if (sameFile(input, identity)) return document;
    }
    return undefined;
}

async function saveModifiedSource(filePath: string, token: vscode.CancellationToken): Promise<void> {
    const open = await modifiedSource(filePath, token);
    throwIfToolCancelled(token);
    if (!open) return;
    if (!await open.save()) throw new ToolError(Messages.tools.runSaveFailed(open.uri.fsPath));
    throwIfToolCancelled(token);
    if (comparablePath(open.uri.fsPath) !== comparablePath(filePath)) {
        const [input, saved] = await Promise.all([fileIdentity(filePath), fileIdentity(open.uri.fsPath)]);
        if (!sameFile(input, saved)) throw new ToolError(Messages.tools.runSourceChanged(open.uri.fsPath));
    }
}

async function statIfPresent(filePath: string): Promise<BigIntStats | undefined> {
    try {
        return await fs.stat(filePath, { bigint: true });
    } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return undefined;
        throw error;
    }
}

function exactOpenDocument(filePath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(document => !document.isClosed && document.uri.fsPath === filePath);
}

async function openDocumentByIdentity(
    filePath: string, candidates: readonly vscode.TextDocument[],
): Promise<vscode.TextDocument | undefined> {
    const input = await statIfPresent(filePath);
    if (!input?.isFile() || input.ino === 0n) return undefined;
    const matches: vscode.TextDocument[] = [];
    for (const document of candidates) {
        if (document.isClosed || !vscode.workspace.textDocuments.includes(document)) continue;
        const candidate = await statIfPresent(document.uri.fsPath);
        if (candidate?.isFile() && candidate.dev === input.dev && candidate.ino === input.ino) matches.push(document);
    }
    const exact = exactOpenDocument(filePath);
    if (exact) return exact;
    const live = matches.filter(document => !document.isClosed && vscode.workspace.textDocuments.includes(document));
    if (live.length > 1) throw new ToolError(Messages.tools.syntaxDocumentAmbiguous(filePath));
    return live[0];
}

function openDocument(filePath: string): vscode.TextDocument | undefined | Promise<vscode.TextDocument | undefined> {
    const exact = exactOpenDocument(filePath);
    if (exact || os.platform() !== 'win32') return exact;
    const key = comparablePath(filePath);
    const candidates = vscode.workspace.textDocuments.filter(document => !document.isClosed
        && document.uri.scheme === 'file' && comparablePath(document.uri.fsPath) === key);
    // Case folding only selects candidates: Windows directories can be case-sensitive.
    return candidates.length ? openDocumentByIdentity(filePath, candidates) : undefined;
}

export function windowRunEnvironment(): RunEnvironment {
    return {
        shell: vscode.env.shell,
        terminalRoot: vscode.workspace.getConfiguration('gap').get<string>('terminalRoot') ?? '',
        wslProfileArgs: defaultWindowsProfileArgs,
        resolveInstallation: () => resolveGapInstallation(),
    };
}

export function createWindowToolHost(context: HelpDataContext): ToolHost {
    return {
        location: context,
        sharedHelpIndex: false,
        helpSettings() {
            const config = vscode.workspace.getConfiguration('gap');
            return {
                docPath: (config.get<string>('docPath') || '').trim(),
                pkgPath: (config.get<string>('pkgPath') || '').trim(),
                searchMode: config.get<string>('searchMode', 'prefix'),
            };
        },
        openDocument,
        isTrusted: () => vscode.workspace.isTrusted,
        saveSource: saveModifiedSource,
        defaultCwd: filePath => getRunCwd(vscode.Uri.file(filePath))?.fsPath ?? os.homedir(),
        runEnvironment: windowRunEnvironment,
    };
}

export function createWindowToolRegistry(context: Pick<vscode.ExtensionContext, 'extension'> & HelpDataContext): ToolRegistry {
    return createToolRegistry(context.extension.packageJSON, createWindowToolHost(context));
}
