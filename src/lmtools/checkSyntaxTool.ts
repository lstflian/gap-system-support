/**
 * Language Model Tool for checking GAP source syntax.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CheckSyntaxInput, CheckSyntaxOutput, ToolError, checkSyntaxText, toolInvoke, toolTry } from './toolCore';

export class CheckSyntaxTool implements vscode.LanguageModelTool<CheckSyntaxInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CheckSyntaxInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return toolInvoke(() => this.runCheck(options.input));
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<CheckSyntaxInput>,
    ): vscode.PreparedToolInvocation {
        return { invocationMessage: `Checking GAP syntax of '${options.input.filePath}'` };
    }

    private runCheck(input: CheckSyntaxInput): CheckSyntaxOutput {
        if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
            throw new ToolError('filePath is required and must be a non-empty string.');
        }
        const filePath = input.filePath.trim();
        if (!path.isAbsolute(filePath)) {
            throw new ToolError('filePath must be an absolute path.');
        }
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
