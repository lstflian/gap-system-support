import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Messages } from '../../shared/messages';

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

/** Collect parser errors, collapsing only ERROR nodes with identical ranges. */
export function collectErrorEntries(rootNode: SyntaxNode, code: string): ErrorEntry[] {
    const entries: ErrorEntry[] = [];
    const unexpectedRanges = new Set<string>();
    const pending = [rootNode];
    while (pending.length > 0) {
        const node = pending.pop()!;
        if (!node.hasError) {
            continue; // Clean subtree, pruned.
        }
        if (node.isMissing) {
            entries.push(missingEntry(node, code));
            continue; // Missing nodes are leaves.
        }
        if (node.isError) {
            const key = `${node.startIndex}:${node.endIndex}`;
            if (!unexpectedRanges.has(key)) {
                unexpectedRanges.add(key);
                entries.push(unexpectedEntry(node, code));
            }
            // Recovery can leave distinct ERRORs and MISSING tokens inside this node.
        }
        // Reverse push preserves parent-first, left-to-right diagnostic order.
        for (let i = node.childCount - 1; i >= 0; i--) {
            const child = node.child(i);
            if (child?.hasError) {
                pending.push(child);
            }
        }
    }
    return entries;
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

function buildSnippet(code: string, startIndex: number, endIndex: number): string {
    const raw = code.slice(startIndex, endIndex);
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= SNIPPET_MAX) {
        return collapsed;
    }
    return collapsed.slice(0, SNIPPET_MAX) + '…';
}

export function errorEntryMessage(entry: ErrorEntry): string {
    return entry.kind === 'missing' ? Messages.diagnostics.missing(entry.token) : Messages.diagnostics.unexpected(entry.snippet);
}

