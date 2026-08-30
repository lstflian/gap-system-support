/**
 * GAP parser wrapper, manages per document syntax trees with incremental updates.
 */

import * as vscode from 'vscode';
import Parser, { type Language, type Tree, type Edit, type Point, type Range as TreeRange } from 'web-tree-sitter';
import { PARSER_MAX_DOCS, PARSER_MAX_IDLE_MS, PARSER_MAX_PENDING_EDITS, PARSER_MAX_TOTAL_TEXT } from '../limits';

let gapParser: Parser | null = null;
let gapLanguage: Language | null = null;

/** One cached document state. */
interface DocState {
    tree: Tree | null;
    generation: number;
    change: DocumentTreeChange | null;
    text: string;
    edits: Edit[];
    editEvents: number;
    version: number;
    lastUsed: number;
}

/** Document states, keyed by uri.toString(). */
const docs = new Map<string, DocState>();
let nextTreeGeneration = 1;

export interface DocumentTreeSnapshot {
    tree: Tree;
    generation: number;
    change: DocumentTreeChange | null;
}

export interface TreeRangeSnapshot {
    startIndex: number;
    endIndex: number;
    startPosition: Point;
    endPosition: Point;
}

export interface DocumentTreeChange {
    fromGeneration: number;
    toGeneration: number;
    fromVersion: number;
    toVersion: number;
    oldTextLength: number;
    newTextLength: number;
    edits: readonly Edit[];
    changedRanges: readonly TreeRangeSnapshot[];
    oldHasError: boolean;
    newHasError: boolean;
}

function nextGeneration(): number {
    return nextTreeGeneration++;
}

function clonePoint(point: Point): Point {
    return { row: point.row, column: point.column };
}

function cloneEdit(edit: Edit): Edit {
    return {
        startIndex: edit.startIndex,
        oldEndIndex: edit.oldEndIndex,
        newEndIndex: edit.newEndIndex,
        startPosition: clonePoint(edit.startPosition),
        oldEndPosition: clonePoint(edit.oldEndPosition),
        newEndPosition: clonePoint(edit.newEndPosition),
    };
}

function cloneRange(range: TreeRange): TreeRangeSnapshot {
    return {
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        startPosition: clonePoint(range.startPosition),
        endPosition: clonePoint(range.endPosition),
    };
}

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

/** Convert a VS Code content change to a syntax tree edit. */
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
    if (state.edits.length > PARSER_MAX_PENDING_EDITS) {
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
        if (now - s.lastUsed > PARSER_MAX_IDLE_MS) dropState(k);
    }
    // Count and total text eviction, least recently used first.
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
    while (docs.size > PARSER_MAX_DOCS) {
        const k = oldestKey();
        if (k === null) break;
        dropState(k);
    }
    let total = 0;
    for (const s of docs.values()) total += s.text.length;
    while (total > PARSER_MAX_TOTAL_TEXT) {
        const k = oldestKey();
        if (k === null) break;
        const len = docs.get(k)?.text.length ?? 0;
        dropState(k);
        total -= len;
    }
}

/**
 * Return the syntax tree, incrementally updated when possible.
 * The tree is only valid for the current synchronous call, the caller must not delete it.
 * The code parameter is the document text when the caller already read it.
 */
export function getDocumentTreeSnapshot(document: vscode.TextDocument, code?: string): DocumentTreeSnapshot {
    const key = document.uri.toString();
    const newText = code ?? document.getText();

    evictIfNeeded(Date.now());

    let state = docs.get(key);

    // First request, full parse.
    if (!state) {
        state = {
            tree: null,
            generation: 0,
            change: null,
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
            state.generation = nextGeneration();
        } catch (err) {
            // Delete the state, the next request reparses from scratch.
            state.tree?.delete();
            docs.delete(key);
            throw err;
        }
        return { tree: state.tree, generation: state.generation, change: state.change };
    }

    // Text unchanged, reuse the cached tree.
    if (newText === state.text) {
        const hadPendingEdits = state.edits.length > 0 || state.editEvents !== 0;
        state.edits = [];
        state.editEvents = 0;
        state.version = document.version;
        state.lastUsed = Date.now();
        if (!state.tree) {
            try {
                state.tree = parseGapCode(newText);
                state.generation = nextGeneration();
            } catch (err) {
                state.tree?.delete();
                docs.delete(key);
                throw err;
            }
        }
        if (hadPendingEdits) state.change = null;
        return { tree: state.tree, generation: state.generation, change: state.change };
    }

    // Partial event loss detection, the version difference must equal the event count.
    const versionJumped =
        document.version < state.version ||
        document.version - state.version !== state.editEvents;
    if (state.edits.length > 0 && !versionJumped && state.tree) {
        // Incremental path.
        const oldTree = state.tree;
        const fromGeneration = state.generation;
        const fromVersion = state.version;
        const oldTextLength = state.text.length;
        const pendingEdits = state.edits.map(cloneEdit);
        const oldHasError = oldTree.rootNode.hasError;
        let newTree: Tree | null = null;
        try {
            if (!gapParser) {
                throw new Error('GAP parser is not initialized. Call initGapParser() first.');
            }
            for (const edit of pendingEdits) oldTree.edit(edit);
            newTree = gapParser.parse(newText, oldTree);
            const changedRanges = oldTree.getChangedRanges(newTree).map(cloneRange);
            const generation = nextGeneration();
            const change: DocumentTreeChange = {
                fromGeneration,
                toGeneration: generation,
                fromVersion,
                toVersion: document.version,
                oldTextLength,
                newTextLength: newText.length,
                edits: pendingEdits,
                changedRanges,
                oldHasError,
                newHasError: newTree.rootNode.hasError,
            };
            oldTree.delete();
            state.tree = newTree;
            state.generation = generation;
            state.change = change;
            newTree = null;
            state.edits = [];
        } catch (err) {
            newTree?.delete();
            if (state.tree === oldTree) oldTree.delete();
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
            state.generation = nextGeneration();
            state.change = null;
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
    return { tree: state.tree, generation: state.generation, change: state.change };
}

export function getDocumentTree(document: vscode.TextDocument, code?: string): Tree {
    return getDocumentTreeSnapshot(document, code).tree;
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
