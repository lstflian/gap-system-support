/** Resolve the active function definition for a hover position. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, getDocumentTree, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor, isTopLevel } from '../shared/treeUtils';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from '../shared/readFileCache';
import { LazyQuery } from '../shared/lazyQuery';
import type { QueryMatch, SyntaxNode, Tree } from 'web-tree-sitter';
import { READ_CONTENT_LIMIT } from '../limits';

/** A definition or Read call in the backward scan. */
type FileEvent =
    | {
        kind: 'def';
        name: string;
        offset: number;
        end: number;
        /** Start index of the enclosing scope, -1 for the global scope. */
        scope: number;
        row: number;
    }
    | { kind: 'read'; pathText: string; offset: number };

/** The key of the always-visible global scope. */
const GLOBAL_SCOPE = -1;

/** Parsed file view with events and source lines. */
interface EventFile {
    events: FileEvent[];
    /** Source lines without trailing line breaks. */
    lines: string[];
}

/** The resolved definition shown in a hover. */
export interface ResolvedDefinition {
    /** The trimmed function definition line. */
    definitionLine: string;
    /** Comment lines directly above the definition. */
    commentLines: string[];
}

export class GapDefinitionResolver {

    private readonly query: LazyQuery;
    private readonly fileCache = new ReadChainFileCache<EventFile>(content => this.parseFile(content));

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf-8'));
    }

    // Cache the parsed event list for each document version.
    private documentCache = new Map<
        string,
        { version: number; tree: Tree; events: FileEvent[]; scopeByStart: Set<number> }
    >();

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
        const lines = text.split(/\r?\n/);

        // Document events: reuse while the document version is unchanged.
        const cacheKey = document.uri.toString();
        let events: FileEvent[];
        let scopeByStart: Set<number>;
        const cached = this.documentCache.get(cacheKey);
        if (cached && cached.version === document.version && cached.tree === tree) {
            events = cached.events;
            scopeByStart = cached.scopeByStart;
        } else {
            const collected = this.collectEvents(tree.rootNode, false);
            events = collected.events.sort((a, b) => a.offset - b.offset);
            scopeByStart = collected.scopeByStart;
            this.documentCache.set(cacheKey, { version: document.version, tree, events, scopeByStart });
        }

        const baseDir = resolveReadBaseDir(document);

        // Phase 0: hovering the definition's own name shows that definition.
        for (const event of events) {
            if (event.kind === 'def' && event.name === name && event.offset <= offset && offset <= event.end) {
                return this.toDefinition({ lines, row: event.row });
            }
        }

        // Phase 1: scoped lookup, the same visibility rules as scoped completion.
        const visible = this.visibleScopes(tree, offset, scopeByStart);
        const scoped = events.filter(
            (e): e is Extract<FileEvent, { kind: 'def' }> =>
                e.kind === 'def' && visible.has(e.scope) && e.end < offset,
        );
        const scopedHit = this.pickLatestByName(scoped, name);
        if (scopedHit) return this.toDefinition({ lines, row: scopedHit.row });

        // Phase 2: global fallback over Read chains and remaining global events.
        // Only events at or before the hover offset take part; Read events keep the chain order.
        const globalScan = events.filter(
            e => e.offset <= offset && (e.kind === 'read' || e.scope === GLOBAL_SCOPE),
        );
        const start = this.scanBackwards(globalScan, lines, new Set([name]), baseDir, new Set());
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
    ): { lines: string[]; row: number } | null {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.kind === 'def') {
                if (names.has(event.name)) return { lines, row: event.row };
            } else if (baseDir) {
                const target = resolveReadTarget(event.pathText, baseDir);
                if (!target || visited.has(target)) continue;
                visited.add(target);
                const read = this.fileCache.loadFile(target);
                if (!read) continue;
                const found = this.scanBackwards(read.events, read.lines, names, baseDir, visited);
                // Continue the upward scan if nothing was found here.
                if (found) return found;
            }
        }
        return null;
    }

    /** Return the definition line and the comment block above it. */
    private toDefinition(start: { lines: string[]; row: number }): ResolvedDefinition {
        const definitionLine = (start.lines[start.row] ?? '').trim();
        const commentLines: string[] = [];
        for (let row = start.row - 1; row >= 0; row--) {
            const line = (start.lines[row] ?? '').trimStart();
            if (!line.startsWith('##')) break;
            commentLines.push(line.replace(/^#+ ?/, ''));
        }
        commentLines.reverse();
        return { definitionLine, commentLines };
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
            });
        }
        return { events, scopeByStart };
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
