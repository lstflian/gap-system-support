/**
 * Registration entry for the language model tools.
 */

import * as vscode from 'vscode';
import { SearchHelpTool } from './searchTool';
import { ListBooksTool } from './listBooksTool';
import { ResolveLinkTool } from './resolveLinkTool';

/** Register the GAP help tools and track them for disposal. */
export function registerLmTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.lm.registerTool('search_gap_help', new SearchHelpTool(context)));
    context.subscriptions.push(vscode.lm.registerTool('list_gap_books', new ListBooksTool(context)));
    context.subscriptions.push(vscode.lm.registerTool('gap_resolve_link', new ResolveLinkTool(context)));
}
