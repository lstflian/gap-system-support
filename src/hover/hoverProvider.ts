/** Provide hover content for GAP function names. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { getFunctionNames } from '../completion/dataManager';
import { GAPDefinitionResolver, ResolvedDefinition } from './definitionResolver';
import { definitionPathLink } from './format';
import { functionNameNodeAt } from '../shared/functionName';
import type { SyntaxNode } from 'web-tree-sitter';

/** English hover texts. */
const FALLBACK_TEXT =
    'No function information found. Please check the function name.\n\n---\n\n' +
    'User defined functions support the following forms:\n\n' +
    '- name := function(...)\n' +
    '- name := atomic function(...)\n' +
    '- name := x -> ...\n' +
    '- name := {x, y, ...} -> ...';

/**
 * Render the hover for a GAP function.
 * Shows the function title and a link into GAP Help.
 */
function systemMarkdown(name: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.searchHelpTerm'] };
    md.appendMarkdown('**GAP function**\n\n---\n\nSee more information in ');
    md.appendMarkdown(
        `[GAP Help](command:gap.searchHelpTerm?${encodeURIComponent(JSON.stringify([name]))})`
    );
    return md;
}

/**
 * Render the hover for a user defined function.
 * Shows the title, a code block, and the comment lines.
 * Appends a Defined in link, or skips it for untitled documents.
 */
function customMarkdown(resolved: ResolvedDefinition): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.goToDefinition'] };
    md.appendMarkdown('**User defined function**\n\n');
    md.appendCodeblock(resolved.definitionLine, 'gap');
    if (resolved.commentLines.length > 0) {
        // A separator between the code block and the comments.
        md.appendMarkdown('\n\n---\n\n');
        for (const line of resolved.commentLines) {
            // Comment lines render as Markdown (bold, code, links, math syntax), one comment line per displayed line.
            // The string is not trusted, so command links stay inert.
            md.appendMarkdown(line);
            md.appendMarkdown('  \n');
        }
    }
    if (resolved.filePath) {
        md.appendMarkdown('\n---\n\n');
        md.appendMarkdown(`Defined in ${definitionPathLink(resolved.filePath, resolved.row)}`);
    }
    return md;
}

export class GAPHoverProvider implements vscode.HoverProvider {

    private resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.Hover | undefined {
        if (!isParserReady()) return undefined;

        // Gate 1: only function name identifiers trigger a hover.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const node = functionNameNodeAt(tree.rootNode, offset);
        if (!node) return undefined;

        const name = node.text;

        // Gate 2: GAP functions win over user defined ones.
        const systemNames = getFunctionNames();
        if (systemNames?.has(name)) {
            return new vscode.Hover(systemMarkdown(name), this.rangeOf(document, node));
        }

        // Gate 3: user defined functions resolved through the Read chain.
        const resolved = this.resolver.resolveDefinition(document, position, name);
        if (resolved) {
            return new vscode.Hover(customMarkdown(resolved), this.rangeOf(document, node));
        }

        // Unknown function names: gentle hint.
        return new vscode.Hover(new vscode.MarkdownString(FALLBACK_TEXT), this.rangeOf(document, node));
    }

    private rangeOf(document: vscode.TextDocument, node: SyntaxNode): vscode.Range {
        return new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column),
        );
    }
}
