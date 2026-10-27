/**
 * Language Model Tool for checking GAP source syntax.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { initGapParser } from '../parser/gapParser';
import { CheckSyntaxInput, CheckSyntaxOutput, ToolError, checkSyntaxText, throwIfToolCancelled, toolInvoke, toolTry } from './toolCore';

export class CheckSyntaxTool implements vscode.LanguageModelTool<CheckSyntaxInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CheckSyntaxInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return toolInvoke(() => this.execute(options.input, token));
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<CheckSyntaxInput>,
    ): vscode.PreparedToolInvocation {
        return { invocationMessage: `Checking GAP syntax of '${options.input.filePath}'` };
    }

    async execute(input: CheckSyntaxInput, token: vscode.CancellationToken): Promise<CheckSyntaxOutput> {
        throwIfToolCancelled(token);
        if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
            throw new ToolError('filePath is required and must be a non-empty string.');
        }
        const filePath = input.filePath.trim();
        if (!path.isAbsolute(filePath)) {
            throw new ToolError('filePath must be an absolute path.');
        }
        await initGapParser(this.context);
        throwIfToolCancelled(token);
        // Prefer the open document buffer so unsaved changes are checked.
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        if (open) {
            return checkSyntaxText(open.getText());
        }
        const code = toolTry(
            () => fs.readFileSync(filePath, 'utf-8'),
            (err) => `Failed to read ${filePath}: ${(err as Error).message}`,
        );
        return checkSyntaxText(code);
    }
}
