/**
 * Language Model Tool for resolving a relative GAP help link.
 */

import * as vscode from 'vscode';
import { ResolveLinkInput, ResolveLinkOutput, ToolError, resolveLinkOutput } from './toolCore';

export class ResolveLinkTool implements vscode.LanguageModelTool<ResolveLinkInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResolveLinkInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const output = resolveLinkOutput(options.input);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(output, null, 2)),
            ]);
        } catch (err) {
            if (err instanceof ToolError) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(err.message),
                ]);
            }
            throw err;
        }
    }

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveLinkInput>): vscode.PreparedToolInvocation {
        return { invocationMessage: `Resolving GAP help link '${options.input.relativePath}'` };
    }
}

