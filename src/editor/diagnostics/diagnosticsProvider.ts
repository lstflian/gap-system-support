/**
 * Diagnostics provider: reports syntax errors from the GAP syntax tree.
 */

import * as vscode from 'vscode';
import { collectErrorEntries, ErrorEntry, errorEntryMessage } from '../../language/analysis/syntaxErrors';
import { getDocumentTreeSnapshot, isParserReady } from '../../language/parser/gapParser';
import { tryValue } from '../../shared/guarded';

/** Debounce for revalidation after typing. */
const DEBOUNCE_MS = 250;

export { collectErrorEntries, computeMissingStart, errorEntryMessage } from '../../language/analysis/syntaxErrors';

export function entriesToDiagnostics(document: vscode.TextDocument, entries: ErrorEntry[]): vscode.Diagnostic[] {
    return entries.map((entry) => {
        const start = document.positionAt(entry.startIndex);
        const end = document.positionAt(entry.endIndex);
        const range = new vscode.Range(start, end);
        const message = errorEntryMessage(entry);
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

    checkNow(document: vscode.TextDocument): void {
        if (!this.isEnabled() || document.languageId !== 'gap') {
            return;
        }
        this.cancelTimer(document.uri.toString());
        this.check(document);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.cancelTimer(uri.toString());
        this.collection.delete(uri);
    }

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
