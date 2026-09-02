/**
 * Language Model Tool for resolving a relative GAP help link.
 */

import * as vscode from 'vscode';
import { ResolveLinkInput, ResolveLinkOutput, ToolError, resolveLinkOutput, toolInvoke } from './toolCore';

export class ResolveLinkTool implements vscode.LanguageModelTool<ResolveLinkInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ResolveLinkInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return toolInvoke(() => resolveLinkOutput(options.input));
    }

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResolveLinkInput>): vscode.PreparedToolInvocation {
        return { invocationMessage: `Resolving GAP help link '${options.input.relativePath}'` };
    }
}

