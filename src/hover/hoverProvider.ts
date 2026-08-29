/** Provide hover content for GAP function names. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { getFunctionNames } from '../completion/dataManager';
import { GapDefinitionResolver, ResolvedDefinition } from './definitionResolver';
import type { SyntaxNode } from 'web-tree-sitter';

/** English hover texts. */
const SYSTEM_FUNCTION_TEXT = 'GAP function, see more information in ';
const FALLBACK_TEXT = 'No function information, please double-check.';

export class GapHoverProvider implements vscode.HoverProvider {

    private resolver: GapDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GapDefinitionResolver(completionPath);
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
        const node = this.functionNameNode(tree.rootNode, offset);
        if (!node) return undefined;

        const name = node.text;

        // Gate 2: system functions win over user defined ones.
        const systemNames = getFunctionNames();
        if (systemNames?.has(name)) {
            return new vscode.Hover(this.systemMarkdown(name), this.rangeOf(document, node));
        }

        // Gate 3: user defined functions resolved through the Read chain.
        const resolved = this.resolver.resolveDefinition(document, position, name);
        if (resolved) {
            return new vscode.Hover(this.customMarkdown(resolved), this.rangeOf(document, node));
        }

        // Unknown function names: gentle hint.
        return new vscode.Hover(new vscode.MarkdownString(FALLBACK_TEXT), this.rangeOf(document, node));
    }

    /** Return the identifier node when the cursor is on a function name. */
    private functionNameNode(root: SyntaxNode, offset: number): SyntaxNode | null {
        const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
        const node = root.descendantForIndex(clamped);
        if (!node || node.type !== 'identifier') return null;

        const parent = node.parent;
        if (!parent) return null;

        if (parent.type === 'assignment_statement') {
            // Node wrappers are recreated per access: compare by node identity id.
            const left = parent.childForFieldName('left');
            if (left && left.id === node.id) {
                const right = parent.childForFieldName('right');
                if (right && (right.type === 'function'
                    || right.type === 'atomic_function'
                    || right.type === 'lambda')) {
                    return node;
                }
            }
        }

        if (parent.type === 'call') {
            const callee = parent.childForFieldName('function');
            // Both builtin calls (Assert, Info, ...) and normal calls hover.
            if (callee && callee.id === node.id) {
                return node;
            }
        }

        return null;
    }

    private systemMarkdown(name: string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = { enabledCommands: ['gap.searchHelpTerm'] };
        md.appendText(SYSTEM_FUNCTION_TEXT);
        md.appendMarkdown(
            `[Search GAP Help](command:gap.searchHelpTerm?${encodeURIComponent(JSON.stringify([name]))}).`
        );
        return md;
    }

    private customMarkdown(resolved: ResolvedDefinition): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(resolved.definitionLine, 'gap');
        if (resolved.commentLines.length > 0) {
            md.appendMarkdown('\n---\n');
            for (const line of resolved.commentLines) {
                // Comment lines render as Markdown (bold, code, links, math syntax), one comment line per displayed line.
                // The string is not trusted, so command links stay inert.
                md.appendMarkdown(line);
                md.appendMarkdown('  \n');
            }
        }
        return md;
    }

    private rangeOf(document: vscode.TextDocument, node: SyntaxNode): vscode.Range {
        return new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column),
        );
    }
}
