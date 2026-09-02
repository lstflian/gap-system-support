/**
 * Diagnostics provider: reports syntax errors from the GAP syntax tree.
 */

import * as vscode from 'vscode';
import { type SyntaxNode } from 'web-tree-sitter';
import { getDocumentTreeSnapshot, isParserReady } from '../parser/gapParser';
import { tryValue } from '../shared/guarded';

/** Debounce for revalidation after typing. */
const DEBOUNCE_MS = 250;

/** Max snippet length shown in "Unexpected syntax" messages. */
const SNIPPET_MAX = 40;

export interface ErrorEntry {
    kind: 'unexpected' | 'missing';
    startIndex: number;
    endIndex: number;
    /** Expected token name for missing nodes (e.g. "fi", ")", ";"). */
    token: string;
    /** Source snippet for unexpected nodes, whitespace collapsed. */
    snippet: string;
}

/** Walk the tree, collecting `isError` and `isMissing` nodes. */
export function collectErrorEntries(rootNode: SyntaxNode, code: string): ErrorEntry[] {
    const entries: ErrorEntry[] = [];
    visit(rootNode, code, entries);
    return entries;
}

function visit(node: SyntaxNode, code: string, entries: ErrorEntry[]): void {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) {
            continue;
        }
        if (!child.hasError) {
            continue; // Clean subtree, pruned.
        }
        if (child.isMissing) {
            entries.push(missingEntry(child, code));
            // Missing nodes are leaves by construction, nothing below.
            continue;
        }
        if (child.isError) {
            entries.push(unexpectedEntry(child, code));
            // Do not descend: nested ERRORs share the same root cause.
            continue;
        }
        visit(child, code, entries);
    }
}

/** Build the entry for a MISSING node with zero width. */
function missingEntry(node: SyntaxNode, code: string): ErrorEntry {
    const offset = node.startIndex;
    return {
        kind: 'missing',
        // Zero width ranges are invisible: back up to the last character that is not whitespace for a visible squiggle.
        startIndex: computeMissingStart(code, offset),
        endIndex: offset,
        token: node.type,
        snippet: '',
    };
}

/**
 * Start offset for a MISSING node squiggle.
 * Covers visible source up to the insertion point.
 * When nothing visible precedes it, the range stays empty.
 */
export function computeMissingStart(code: string, offset: number): number {
    const bounded = Math.max(0, Math.min(offset, code.length));
    let i = bounded - 1;
    while (i > 0 && isSpace(code.charCodeAt(i))) {
        i--;
    }
    if (i < 0 || (i === 0 && isSpace(code.charCodeAt(0)))) {
        // Nothing visible before the insertion point: keep the range empty.
        return bounded;
    }
    return i;
}

function isSpace(c: number): boolean {
    return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Build the entry for an ERROR (unexpected syntax) node. */
function unexpectedEntry(node: SyntaxNode, code: string): ErrorEntry {
    const startIndex = node.startIndex;
    const endIndex = Math.min(Math.max(node.endIndex, startIndex), code.length);
    return {
        kind: 'unexpected',
        startIndex,
        endIndex,
        token: '',
        snippet: buildSnippet(code, startIndex, endIndex),
    };
}

/** Collapse whitespace and truncate the snippet for the message. */
function buildSnippet(code: string, startIndex: number, endIndex: number): string {
    const raw = code.slice(startIndex, endIndex);
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= SNIPPET_MAX) {
        return collapsed;
    }
    return collapsed.slice(0, SNIPPET_MAX) + '…';
}

/** Convert raw entries to VS Code diagnostics. */
export function entriesToDiagnostics(document: vscode.TextDocument, entries: ErrorEntry[]): vscode.Diagnostic[] {
    return entries.map((entry) => {
        const start = document.positionAt(entry.startIndex);
        const end = document.positionAt(entry.endIndex);
        const range = new vscode.Range(start, end);
        const message = entry.kind === 'missing' ? `Missing "${entry.token}"` : `Unexpected syntax: ${entry.snippet}`;
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'gap';
        return diagnostic;
    });
}

/**
 * Publishes GAP syntax errors as squiggles and Problems panel entries.
 * Validation is debounced on typing and retracted when a document closes.
 */
export class GAPDiagnosticsProvider implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('gap');
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Schedule a debounced validation after typing (250 ms). */
    schedule(document: vscode.TextDocument): void {
        if (!this.isEnabled() || document.languageId !== 'gap') {
            return;
        }
        this.scheduleWithDelay(document, DEBOUNCE_MS);
    }

    /** Validate immediately, bypassing the debounce. */
    checkNow(document: vscode.TextDocument): void {
        if (!this.isEnabled() || document.languageId !== 'gap') {
            return;
        }
        this.cancelTimer(document.uri.toString());
        this.check(document);
    }

    /** Drop diagnostics and any pending timer for a closed document. */
    onDocumentClosed(uri: vscode.Uri): void {
        this.cancelTimer(uri.toString());
        this.collection.delete(uri);
    }

    /** React to the `gap.diagnostics` setting: refresh or clear everything. */
    onConfigurationChanged(): void {
        if (!this.isEnabled()) {
            this.clearAll();
            return;
        }
        for (const document of vscode.workspace.textDocuments) {
            this.checkNow(document);
        }
    }

    dispose(): void {
        this.clearAll();
        this.collection.dispose();
    }

    private clearAll(): void {
        for (const key of Array.from(this.timers.keys())) {
            this.cancelTimer(key);
        }
        this.collection.clear();
    }

    private scheduleWithDelay(document: vscode.TextDocument, delayMs: number): void {
        const clearKey = document.uri.toString();
        const existing = this.timers.get(clearKey);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.timers.delete(clearKey);
            this.check(document);
        }, delayMs);
        this.timers.set(clearKey, timer);
    }

    private cancelTimer(key: string): void {
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
    }

    private check(document: vscode.TextDocument): void {
        if (!this.isEnabled() || document.languageId !== 'gap' || !isParserReady()) {
            return;
        }
        const uri = document.uri;
        const diagnostics = tryValue(
            (): vscode.Diagnostic[] | null => {
                const text = document.getText();
                const { tree } = getDocumentTreeSnapshot(document, text);
                // O(1) gate: clean trees never enter the collector.
                const entries = tree.rootNode.hasError ? collectErrorEntries(tree.rootNode, text) : [];
                return entriesToDiagnostics(document, entries);
            },
            null,
        );
        if (diagnostics === null) {
            // Parser failures must never surface as broken editor state; retract stale diagnostics and let the next change retry.
            this.collection.delete(uri);
        } else {
            this.collection.set(uri, diagnostics);
        }
    }

    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration('gap').get<boolean>('diagnostics', true);
    }
}
