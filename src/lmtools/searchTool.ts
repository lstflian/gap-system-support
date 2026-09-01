/**
 * Language Model Tool for searching the GAP help index.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { ensureHelpIndex, getHelpState } from '../help/helpData';
import { CONFIG_MISSING_MESSAGE, SearchInput, SearchOutput, ToolError, searchHelpTool } from './toolCore';

export class SearchHelpTool implements vscode.LanguageModelTool<SearchInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const output = this.runSearch(options.input);
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

    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SearchInput>): vscode.PreparedToolInvocation {
        return { invocationMessage: `Searching the GAP help index for '${options.input.topic}'` };
    }

    private runSearch(input: SearchInput): SearchOutput {
        const config = vscode.workspace.getConfiguration('gap');
        const docPath = (config.get<string>('docPath') || '').trim();
        const pkgPath = (config.get<string>('pkgPath') || '').trim();
        if (!docPath || !fs.existsSync(docPath) || !pkgPath || !fs.existsSync(pkgPath)) {
            throw new ToolError(CONFIG_MISSING_MESSAGE);
        }
        const searchMode = config.get<string>('searchMode', 'prefix');
        const defaultMode = searchMode === 'substring' ? 'substring' : 'prefix';
        try {
            ensureHelpIndex(this.context);
        } catch (err) {
            throw new ToolError(`The GAP help index could not be loaded: ${(err as Error).message}`);
        }
        const state = getHelpState();
        if (!state.entries.length) {
            throw new ToolError('The GAP help index is empty. Try "GAP: Rebuild Help Index" first.');
        }
        return searchHelpTool(input, state.entries, state.bookDescriptions, docPath, pkgPath, defaultMode);
    }
}
