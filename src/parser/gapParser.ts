/**
 * GAP parser wrapper, manages per document syntax trees with incremental updates.
 */

import * as vscode from 'vscode';
import Parser, { type Language, type Tree, type Edit, type Point } from 'web-tree-sitter';

let gapParser: Parser | null = null;
let gapLanguage: Language | null = null;

/** One cached document state. */
interface DocState {
    tree: Tree | null;
    text: string;
    edits: Edit[];
    editEvents: number;
    version: number;
    lastUsed: number;
}

/** Document states, keyed by uri.toString(). */
const docs = new Map<string, DocState>();

/** Cache limits for the document map. */
const MAX_DOCS = 20;
const MAX_TOTAL_TEXT = 50 * 1024 * 1024;
const MAX_IDLE_MS = 3 * 60 * 1000;
const MAX_PENDING_EDITS = 1000;

/** Initialize the GAP language WASM parser. */
export async function initGapParser(context: vscode.ExtensionContext): Promise<void> {
    if (gapParser) return;

    try {
        const wasmPath = vscode.Uri.joinPath(context.extensionUri, 'wasm', 'tree-sitter-gap.wasm').fsPath;

        await Parser.init();
        gapLanguage = await Parser.Language.load(wasmPath);
        gapParser = new Parser();
        gapParser.setLanguage(gapLanguage);
    } catch (err) {
        gapParser?.delete();
        gapParser = null;
        gapLanguage = null;
        throw err;
    }

    console.log('[GAP] parser initialized');
}

/** Return the loaded GAP language object. */
export function getGapLanguage(): Language {
    if (!gapLanguage) {
        throw new Error('GAP language is not loaded. Call initGapParser() first.');
    }
    return gapLanguage;
}

/** Stateless full parse. */
export function parseGapCode(code: string): Tree {
    if (!gapParser) {
        throw new Error('GAP parser is not initialized. Call initGapParser() first.');
    }
    return gapParser.parse(code);
}

/** Return whether the parser is ready. */
export function isParserReady(): boolean {
    return gapParser !== null;
}

/** Convert a VS Code content change to a tree-sitter edit. */
function toTreeSitterEdit(c: vscode.TextDocumentContentChangeEvent): Edit {
    const startIndex = c.rangeOffset;
    const oldEndIndex = c.rangeOffset + c.rangeLength;
    const newEndIndex = startIndex + c.text.length;
    return {
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition: { row: c.range.start.line, column: c.range.start.character },
        oldEndPosition: { row: c.range.end.line, column: c.range.end.character },
        newEndPosition: computeEndPosition(c.range.start, c.text),
    };
}

/** End position after inserting text, only a line feed advances the row. */
function computeEndPosition(start: vscode.Position, text: string): Point {
    let row = start.line;
    let col = start.character;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            row++;
            col = 0;
        } else {
            col++;
        }
    }
    return { row, column: col };
}

/** Record a content change, keep the original contentChanges order. */
export function onDocumentChanged(uri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    const state = docs.get(uri.toString());
    if (!state) return;
    state.editEvents++;
    for (const c of changes) {
        state.edits.push(toTreeSitterEdit(c));
    }
    // Over the cap, force a full reparse on the next request.
    // A negative event count marks the loss, the next request reparses.
    if (state.edits.length > MAX_PENDING_EDITS) {
        state.edits = [];
        state.editEvents = -1;
    }
}

/** Release the cached tree of a closed document. */
export function onDocumentClosed(uri: vscode.Uri): void {
    dropState(uri.toString());
}

/** Delete one document state and its tree. */
function dropState(key: string): void {
    const state = docs.get(key);
    if (state) {
        state.tree?.delete();
        docs.delete(key);
    }
}

/** Evict old states lazily, the freshly created keepKey is never evicted. */
function evictIfNeeded(now: number, keepKey?: string): void {
    // Idle eviction.
    for (const [k, s] of [...docs]) {
        if (k === keepKey) continue;
        if (now - s.lastUsed > MAX_IDLE_MS) dropState(k);
    }
    // Count and total text eviction, oldest first.
    const oldestKey = (): string | null => {
        let key: string | null = null;
        let oldest = Infinity;
        for (const [k, s] of docs) {
            if (k === keepKey) continue;
            if (s.lastUsed < oldest) {
                oldest = s.lastUsed;
                key = k;
            }
        }
        return key;
    };
    while (docs.size > MAX_DOCS) {
        const k = oldestKey();
        if (k === null) break;
        dropState(k);
    }
    let total = 0;
    for (const s of docs.values()) total += s.text.length;
    while (total > MAX_TOTAL_TEXT) {
        const k = oldestKey();
        if (k === null) break;
        const len = docs.get(k)?.text.length ?? 0;
        dropState(k);
        total -= len;
    }
}

/**
 * Return the document tree, incrementally updated when possible.
 * The tree is only valid for the current synchronous call, the caller must not delete it.
 * The code parameter is the document text when the caller already read it.
 */
export function getDocumentTree(document: vscode.TextDocument, code?: string): Tree {
    const key = document.uri.toString();
    const newText = code ?? document.getText();

    evictIfNeeded(Date.now());

    let state = docs.get(key);

    // First request, full parse.
    if (!state) {
        state = {
            tree: null,
            text: newText,
            edits: [],
            editEvents: 0,
            version: document.version,
            lastUsed: Date.now(),
        };
        docs.set(key, state);
        // The freshly created state is never evicted.
        evictIfNeeded(Date.now(), key);
        try {
            state.tree = parseGapCode(newText);
        } catch (err) {
            // Delete the state, the next request reparses from scratch.
            state.tree?.delete();
            docs.delete(key);
            throw err;
        }
        return state.tree;
    }

    // Text unchanged, reuse the cached tree.
    if (newText === state.text) {
        state.edits = [];
        state.editEvents = 0;
        state.version = document.version;
        state.lastUsed = Date.now();
        if (!state.tree) {
            try {
                state.tree = parseGapCode(newText);
            } catch (err) {
                state.tree?.delete();
                docs.delete(key);
                throw err;
            }
        }
        return state.tree;
    }

    // Partial event loss detection, the version difference must equal the event count.
    const versionJumped =
        document.version < state.version ||
        document.version - state.version !== state.editEvents;
    if (state.edits.length > 0 && !versionJumped && state.tree) {
        // Incremental path.
        try {
            if (!gapParser) {
                throw new Error('GAP parser is not initialized. Call initGapParser() first.');
            }
            for (const e of state.edits) state.tree.edit(e);
            const oldTree = state.tree;
            state.tree = gapParser.parse(newText, oldTree);
            oldTree.delete();
            state.edits = [];
        } catch (err) {
            state.tree?.delete();
            docs.delete(key);
            throw err;
        }
    } else {
        // Event loss or version jump, full parse fallback.
        const oldTree = state.tree;
        state.tree = null;
        oldTree?.delete();
        try {
            state.tree = parseGapCode(newText);
            state.edits = [];
        } catch (err) {
            state.tree?.delete();
            docs.delete(key);
            throw err;
        }
    }
    state.editEvents = 0;
    state.text = newText;
    state.version = document.version;
    state.lastUsed = Date.now();
    return state.tree;
}

/** Release all cached trees and the parser on deactivation. */
export function disposeAll(): void {
    for (const state of docs.values()) {
        state.tree?.delete();
    }
    docs.clear();
    gapParser?.delete();
    gapParser = null;
    gapLanguage = null;
}
