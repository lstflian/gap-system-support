import * as os from 'os';
import * as path from 'path';
import { promises as fs, BigIntStats, constants as fsConstants } from 'fs';
import * as vscode from 'vscode';
import { getRunCwd } from '../path';
import { GapRunner } from '../shared/gapRun';
import { getErrorMessage, Messages } from '../shared/messages';
import { ToolError, throwIfToolCancelled, toolInvoke } from './toolCore';
import type { ToolExecutionContext } from './registry';

export interface RunFileInput {
    filePath: string;
    outputPath: string;
    cwd?: string;
}

export interface RunFileOutput {
    completed: true;
}

function validatePath(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0') || !path.isAbsolute(value)
        || (os.platform() === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value))) {
        throw new ToolError(Messages.tools.runPathRequired(name));
    }
}

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
            if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
            throw error;
        }
        if (sameFile(input, identity)) return document;
    }
    return undefined;
}

export class RunFileTool implements vscode.LanguageModelTool<RunFileInput>, vscode.Disposable {
    private readonly runner = new GapRunner();
    private disposed = false;

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunFileInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return toolInvoke(() => this.execute(options.input, token));
    }

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RunFileInput>): vscode.PreparedToolInvocation {
        const { filePath, outputPath, cwd } = options.input;
        return {
            invocationMessage: Messages.tools.runInvocation(filePath, outputPath),
            confirmationMessages: {
                title: Messages.tools.runConfirmationTitle,
                message: Messages.tools.runConfirmation(filePath, outputPath, cwd),
            },
        };
    }

    async execute(input: RunFileInput, token: vscode.CancellationToken, context?: ToolExecutionContext): Promise<RunFileOutput> {
        throwIfToolCancelled(token);
        if (this.disposed) throw new ToolError(Messages.tools.runClosed);
        if (!vscode.workspace.isTrusted) throw new ToolError(Messages.tools.runUntrusted);
        validatePath(input.filePath, 'filePath');
        validatePath(input.outputPath, 'outputPath');
        const filePath = path.resolve(input.filePath);
        const outputPath = path.resolve(input.outputPath);
        const uri = vscode.Uri.file(filePath);
        let cwd: string | undefined;
        try {
            if (input.cwd !== undefined) {
                if (typeof input.cwd !== 'string' || !input.cwd.trim() || input.cwd.includes('\0')
                    || !path.isAbsolute(input.cwd)
                    || (os.platform() === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(input.cwd))) {
                    throw new ToolError(Messages.tools.runCwdRequired);
                }
                cwd = path.resolve(input.cwd);
                if (!(await fs.stat(cwd)).isDirectory()) throw new ToolError(Messages.tools.runCwdNotDirectory);
                await fs.access(cwd, fsConstants.X_OK);
                throwIfToolCancelled(token);
            }
            const open = await modifiedSource(filePath, token);
            throwIfToolCancelled(token);
            if (open) {
                if (!await open.save()) throw new ToolError(Messages.tools.runSaveFailed(open.uri.fsPath));
                throwIfToolCancelled(token);
                if (comparablePath(open.uri.fsPath) !== comparablePath(filePath)) {
                    const [input, saved] = await Promise.all([fileIdentity(filePath), fileIdentity(open.uri.fsPath)]);
                    if (!sameFile(input, saved)) throw new ToolError(Messages.tools.runSourceChanged(open.uri.fsPath));
                }
            }
            throwIfToolCancelled(token);
            if (!vscode.workspace.isTrusted) throw new ToolError(Messages.tools.runUntrusted);
            const runCwd = input.cwd === undefined ? getRunCwd(uri)?.fsPath ?? os.homedir() : cwd;
            await this.runner.run(filePath, outputPath, uri, runCwd, token, context?.claimOutput, context?.openOutput);
            throwIfToolCancelled(token);
            return { completed: true };
        } catch (error) {
            if (error instanceof ToolError || error instanceof vscode.CancellationError) throw error;
            throw new ToolError(Messages.tools.runFailed(getErrorMessage(error)));
        }
    }

    dispose(): void {
        this.disposed = true;
        this.runner.dispose();
    }

    close(): Promise<void> {
        this.dispose();
        return this.runner.close();
    }
}
