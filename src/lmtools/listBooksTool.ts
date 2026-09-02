/**
 * Language Model Tool for listing the GAP help books.
 */

import * as vscode from 'vscode';
import { ensureHelpIndex, getHelpState } from '../help/helpData';
import { BookInfo, ToolError, listBooksOutput, toolInvoke, toolTry } from './toolCore';

export class ListBooksTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        return toolInvoke(() => this.listBooks());
    }

    prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>): vscode.PreparedToolInvocation {
        return { invocationMessage: 'Listing the GAP help books' };
    }

    private listBooks(): { books: BookInfo[] } {
        toolTry(
            () => ensureHelpIndex(this.context),
            err => `The GAP help index could not be loaded: ${(err as Error).message}`,
        );
        const state = getHelpState();
        if (!state.entries.length) {
            throw new ToolError('The GAP help index is empty. Try "GAP: Rebuild Help Index" first.');
        }
        return listBooksOutput(state.bookDescriptions);
    }
}
