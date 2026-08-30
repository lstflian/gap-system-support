/** Resolve the active function definition for a hover position. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, getDocumentTree, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor, isTopLevel } from '../shared/treeUtils';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from '../shared/readFileCache';
import { LruCache } from '../shared/lruCache';
import { LazyQuery } from '../shared/lazyQuery';
import type { QueryMatch, SyntaxNode, Tree } from 'web-tree-sitter';
import { HOVER_DOCUMENT_CACHE_MAX_ENTRIES, READ_CONTENT_LIMIT } from '../limits';

/** A definition or Read call in the backward scan. */
type FileEvent =
    | {
        kind: 'def';
        name: string;
        offset: number;
        end: number;
        /** Start index of the enclosing scope, negative one for the global scope. */
        scope: number;
        row: number;
        /**
         * The function header text from the syntax tree.
         * Null for lambdas and definitions without a parameter list.
         */
        headerText: string | null;
    }
    | { kind: 'read'; pathText: string; offset: number };

/** The key of the always visible global scope. */
const GLOBAL_SCOPE = -1;

/** Parsed file view with events and source lines. */
interface EventFile {
    events: FileEvent[];
    /** Source lines without trailing line breaks. */
    lines: string[];
}

/** The resolved definition shown in a hover. */
export interface ResolvedDefinition {
    /** The trimmed definition line. */
    definitionLine: string;
    /** Comment lines directly above the definition. */
    commentLines: string[];
    /** Absolute path of the file containing the definition, or '' for untitled. */
    filePath: string;
    /** Row of the definition line, zero based. */
    row: number;
}

export class GAPDefinitionResolver {

    private readonly query: LazyQuery;
    private readonly fileCache = new ReadChainFileCache<EventFile>(content => this.parseFile(content));

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf-8'));
    }

    // Cache the parsed event list and source lines for each document version.
    private documentCache = new LruCache<
        string,
        { version: number; tree: Tree; events: FileEvent[]; scopeByStart: Set<number>; lines: string[] }
    >({ maxEntries: HOVER_DOCUMENT_CACHE_MAX_ENTRIES });

    onDocumentClosed(uri: vscode.Uri): void {
        this.fileCache.onDocumentClosed(uri);
        this.documentCache.delete(uri.toString());
    }

    /** Resolve the active definition for the given function name. */
    resolveDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition | null {
        if (!isParserReady()) return null;

        const text = document.getText();
        if (text.length > READ_CONTENT_LIMIT) return null;

        const tree = getDocumentTree(document, text);
        if (!tree) return null;

        const offset = document.offsetAt(position);

        // Document events and lines: reuse while the document version is unchanged.
        const cacheKey = document.uri.toString();
        let events: FileEvent[];
        let scopeByStart: Set<number>;
        let lines: string[];
        const cached = this.documentCache.peek(cacheKey);
        if (cached && cached.version === document.version && cached.tree === tree) {
            this.documentCache.touch(cacheKey, cached);
            events = cached.events;
            scopeByStart = cached.scopeByStart;
            lines = cached.lines;
        } else {
            const collected = this.collectEvents(tree.rootNode, false);
            events = collected.events.sort((a, b) => a.offset - b.offset);
            scopeByStart = collected.scopeByStart;
            lines = text.split(/\r?\n/);
            this.documentCache.set(cacheKey, { version: document.version, tree, events, scopeByStart, lines });
        }

        const baseDir = resolveReadBaseDir(document);
        // Untitled documents have no real file: no Go to Definition link.
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;

        // Phase 0: hovering the definition's own name shows that definition.
        for (const event of events) {
            if (event.kind === 'def' && event.name === name && event.offset <= offset && offset <= event.end) {
                return this.toDefinition({ lines, row: event.row, filePath: currentFilePath, headerText: event.headerText, name: event.name });
            }
        }

        // Phase 1: scoped lookup, the same visibility rules as scoped completion.
        const visible = this.visibleScopes(tree, offset, scopeByStart);
        const scoped = events.filter(
            (e): e is Extract<FileEvent, { kind: 'def' }> =>
                e.kind === 'def' && visible.has(e.scope) && e.end < offset,
        );
        const scopedHit = this.pickLatestByName(scoped, name);
        if (scopedHit) {
            return this.toDefinition({ lines, row: scopedHit.row, filePath: currentFilePath, headerText: scopedHit.headerText, name: scopedHit.name });
        }

        // Phase 2: global fallback over Read chains and remaining global events.
        // Only events at or before the hover offset take part; Read events keep the chain order.
        const globalScan = events.filter(
            e => e.offset <= offset && (e.kind === 'read' || e.scope === GLOBAL_SCOPE),
        );
        const start = this.scanBackwards(globalScan, lines, new Set([name]), baseDir, new Set(), currentFilePath);
        return start ? this.toDefinition(start) : null;
    }

    /** Collect the scope keys visible at the offset, mirroring scoped.ts getItems. */
    private visibleScopes(tree: Tree, offset: number, scopeByStart: Set<number>): Set<number> {
        const clamped = Math.max(0, Math.min(offset, tree.rootNode.endIndex));
        const visible = new Set<number>([GLOBAL_SCOPE]);
        let current: SyntaxNode | null =
            clamped >= tree.rootNode.endIndex ? tree.rootNode : tree.rootNode.descendantForIndex(clamped);
        while (current && current.type !== 'source_file') {
            if (current.type === 'ERROR') {
                // Scopes inside an ERROR subtree are unreliable, drop them.
                visible.clear();
                visible.add(GLOBAL_SCOPE);
            } else if (scopeByStart.has(current.startIndex)) {
                visible.add(current.startIndex);
            }
            current = current.parent;
        }
        return visible;
    }

    /** The latest (max end) scoped def carrying the searched name. */
    private pickLatestByName(defs: Extract<FileEvent, { kind: 'def' }>[], name: string) {
        let best: Extract<FileEvent, { kind: 'def' }> | null = null;
        for (const d of defs) {
            if (d.name !== name) continue;
            if (!best || d.end > best.end) best = d;
        }
        return best;
    }

    /** Scan backward through the current file and nested Read files. */
    private scanBackwards(
        events: FileEvent[],
        lines: string[],
        names: Set<string>,
        baseDir: string | null,
        visited: Set<string>,
        currentFilePath: string,
    ): { lines: string[]; row: number; filePath: string; headerText: string | null; name: string } | null {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.kind === 'def') {
                if (names.has(event.name)) {
                    return { lines, row: event.row, filePath: currentFilePath, headerText: event.headerText, name: event.name };
                }
            } else if (baseDir) {
                const target = resolveReadTarget(event.pathText, baseDir);
                if (!target || visited.has(target)) continue;
                visited.add(target);
                const read = this.fileCache.loadFile(target);
                if (!read) continue;
                const found = this.scanBackwards(read.events, read.lines, names, baseDir, visited, target);
                // Continue the upward scan if nothing was found here.
                if (found) return found;
            }
        }
        return null;
    }

    /** Return the definition line, the comment block above it, and the location. */
    private toDefinition(start: {
        lines: string[];
        row: number;
        filePath: string;
        headerText: string | null;
        name: string;
    }): ResolvedDefinition {
        const rawLine = (start.lines[start.row] ?? '').trim();
        // The display line is `name := header` (e.g. `a := function(x, y)`).
        // This drops inline comments and single line bodies.
        // Lambdas have no parameter list, so the raw line is shown as is.
        const definitionLine =
            start.headerText !== null ? `${start.name} := ${start.headerText}` : rawLine;
        const commentLines: string[] = [];
        for (let row = start.row - 1; row >= 0; row--) {
            const line = (start.lines[row] ?? '').trimStart();
            if (!line.startsWith('##')) break;
            commentLines.push(line.replace(/^#+ ?/, ''));
        }
        commentLines.reverse();
        return { definitionLine, commentLines, filePath: start.filePath, row: start.row };
    }

    /** Collect definition and Read events plus the scope index for one parsed file. */
    private collectEvents(rootNode: SyntaxNode, topLevelOnly: boolean): { events: FileEvent[]; scopeByStart: Set<number> } {
        const events: FileEvent[] = [];
        // Scope nodes of this file, from the shared completion.scm capture.
        const scopeByStart = new Set<number>();
        const defNodes: { node: SyntaxNode; keep: boolean }[] = [];
        for (const match of this.query.get().matches(rootNode) as QueryMatch[]) {
            let fnNode: SyntaxNode | null = null;
            let readFn = '';
            let readPath = '';
            let readCall: SyntaxNode | null = null;
            for (const capture of match.captures) {
                const node = capture.node;
                if (capture.name === 'completion.function') {
                    if (!hasErrorAncestor(node)) fnNode = node;
                } else if (capture.name === 'completion.read-fn') {
                    if (!hasErrorAncestor(node)) readFn = node.text;
                } else if (capture.name === 'completion.read-path') {
                    if (!hasErrorAncestor(node)) readPath = node.text;
                } else if (capture.name === 'completion.read-call') {
                    readCall = node;
                } else if (capture.name === 'completion.scope') {
                    if (!hasErrorAncestor(node)) scopeByStart.add(node.startIndex);
                }
            }
            if (fnNode) {
                defNodes.push({ node: fnNode, keep: !topLevelOnly || isTopLevel(fnNode) });
            }
            if (readFn === 'Read' && readPath && readCall && !hasErrorAncestor(readCall)) {
                events.push({ kind: 'read', pathText: readPath, offset: readCall.endIndex });
            }
        }

        // Attach every definition to its innermost enclosing scope, as scoped.ts does.
        for (const { node, keep } of defNodes) {
            if (!keep) continue;
            let scope = GLOBAL_SCOPE;
            let current: SyntaxNode | null = node.parent;
            while (current && current.type !== 'source_file') {
                if (scopeByStart.has(current.startIndex)) {
                    scope = current.startIndex;
                    break;
                }
                current = current.parent;
            }
            events.push({
                kind: 'def',
                name: node.text,
                offset: node.startIndex,
                end: node.endIndex,
                scope,
                row: node.startPosition.row,
                headerText: this.functionHeaderText(node),
            });
        }
        return { events, scopeByStart };
    }

    /**
     * Slice the function header text from the syntax tree.
     * Returns null for lambdas and definitions without a parameter list.
     * Multiline parameter lists are flattened to single spaces.
     */
    private functionHeaderText(fnNode: SyntaxNode): string | null {
        const parent = fnNode.parent;
        if (!parent || parent.type !== 'assignment_statement') return null;
        const right = parent.childForFieldName('right');
        if (!right || (right.type !== 'function' && right.type !== 'atomic_function')) return null;
        const params = right.childForFieldName('parameters');
        if (!params) return null;
        return right.text.slice(0, params.endIndex - right.startIndex).replace(/\s+/g, ' ').trimEnd();
    }

    private parseFile(content: string): EventFile | null {
        const tree = parseGapCode(content);
        try {
            const { events } = this.collectEvents(tree.rootNode, true);
            events.sort((a, b) => a.offset - b.offset);
            return { events, lines: content.split(/\r?\n/) };
        } finally {
            tree.delete();
        }
    }
}
