/**
 * GAP completion provider.
 * Provides 4 static categories: builtin constants, keywords, statement snippets, GAP functions.
 * Filtering and sorting are handled by VS Code.
 */

import * as vscode from 'vscode';
import { GAP_KEYWORDS } from './keywords';
import { STATEMENT_SNIPPETS, type StatementSnippet } from './snippets';
import { GAP_CONSTANTS } from './constants';
import { getFunctionNames } from './dataManager';

const SORT_CONSTANT = '01-';
const SORT_KEYWORD = '02-';
const SORT_SNIPPET = '03-';
const SORT_FUNCTION = '04-';

const DETAIL_CONSTANT = 'constant';
const DETAIL_KEYWORD = 'keyword';
const DETAIL_SNIPPET = 'statement';
const DETAIL_FUNCTION = 'GAP function';

/** Build the completion item for one builtin constant. */
function constantItem(name: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
    item.detail = DETAIL_CONSTANT;
    item.sortText = SORT_CONSTANT + name;
    return item;
}

/** Build the completion item for one keyword. */
function keywordItem(name: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
    item.detail = DETAIL_KEYWORD;
    item.sortText = SORT_KEYWORD + name;
    return item;
}

/** Build the completion item for one statement snippet. */
function snippetItem(s: StatementSnippet): vscode.CompletionItem {
    const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
    item.insertText = new vscode.SnippetString(s.insertText);
    item.filterText = s.filterText;
    item.detail = DETAIL_SNIPPET;
    item.sortText = `${SORT_SNIPPET}${s.filterText}-${s.index}`;
    return item;
}

/** Build the completion item for one function. */
function functionItem(name: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
    item.detail = DETAIL_FUNCTION;
    item.sortText = SORT_FUNCTION + name;
    return item;
}

export class GapCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // 1. Builtin constants.
        for (const name of GAP_CONSTANTS) {
            items.push(constantItem(name));
        }

        // 2. Keywords.
        for (const name of GAP_KEYWORDS) {
            items.push(keywordItem(name));
        }

        // 3. Statement snippets.
        for (const s of STATEMENT_SNIPPETS) {
            items.push(snippetItem(s));
        }

        // 4. GAP functions, loaded into memory by dataManager.
        const functionNames = getFunctionNames();
        if (functionNames) {
            for (const name of functionNames) {
                items.push(functionItem(name));
            }
        }

        return items;
    }
}
