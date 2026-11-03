import { promises as fs, constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import { GapRunner } from '../runtime/gapRun';
import { isCancellationError } from '../shared/cancellation';
import { getErrorMessage, Messages } from '../shared/messages';
import type { GapTool, PreparedInvocation, ToolHost } from './contracts';
import { throwIfToolCancelled, ToolError } from './core/toolCore';

export interface RunFileInput {
    filePath: string;
    outputPath: string;
    cwd?: string;
}

export interface RunFileOutput {
    completed: true;
}

function isAbsoluteInput(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') && path.isAbsolute(value)
        && (os.platform() !== 'win32' || /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value));
}

function validatePath(value: string, name: string): void {
    if (!isAbsoluteInput(value)) throw new ToolError(Messages.tools.runPathRequired(name));
}

export class RunFileTool implements GapTool<RunFileInput, RunFileOutput> {
    private readonly runner = new GapRunner();
    private disposed = false;

    constructor(private readonly host: ToolHost) {}

    prepare(input: RunFileInput): PreparedInvocation {
        const { filePath, outputPath, cwd } = input;
        return {
            invocationMessage: Messages.tools.runInvocation(filePath, outputPath),
            confirmationMessages: {
                title: Messages.tools.runConfirmationTitle,
                message: Messages.tools.runConfirmation(filePath, outputPath, cwd),
            },
        };
    }

    async execute(input: RunFileInput, token: CancellationToken): Promise<RunFileOutput> {
        throwIfToolCancelled(token);
        if (this.disposed) throw new ToolError(Messages.tools.runClosed);
        if (!this.host.isTrusted()) throw new ToolError(Messages.tools.runUntrusted);
        validatePath(input.filePath, 'filePath');
        validatePath(input.outputPath, 'outputPath');
        const filePath = path.resolve(input.filePath);
        const outputPath = path.resolve(input.outputPath);
        let cwd: string | undefined;
        try {
            if (input.cwd !== undefined) {
                if (!isAbsoluteInput(input.cwd)) throw new ToolError(Messages.tools.runCwdRequired);
                cwd = path.resolve(input.cwd);
                if (!(await fs.stat(cwd)).isDirectory()) throw new ToolError(Messages.tools.runCwdNotDirectory);
                await fs.access(cwd, fsConstants.X_OK);
                throwIfToolCancelled(token);
            }
            await this.host.saveSource(filePath, token);
            throwIfToolCancelled(token);
            if (!this.host.isTrusted()) throw new ToolError(Messages.tools.runUntrusted);
            const runCwd = cwd ?? this.host.defaultCwd(filePath);
            await this.runner.run(filePath, outputPath, runCwd, token, this.host.runEnvironment());
            throwIfToolCancelled(token);
            return { completed: true };
        } catch (error) {
            if (error instanceof ToolError || isCancellationError(error)) throw error;
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
