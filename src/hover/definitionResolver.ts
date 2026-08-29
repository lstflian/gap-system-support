/** Resolve the active function definition for a hover position. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGapLanguage, parseGapCode, getDocumentTree, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor } from '../semantic/locals';
import { isTopLevel } from '../completion/readCompletions';
import type { Query, QueryMatch, SyntaxNode, Tree } from 'web-tree-sitter';

/** Skip files longer than this limit during hover resolution. */
const CONTENT_LENGTH_LIMIT = 1 * 1024 * 1024;

/** A definition or Read call in the backward scan. */
type FileEvent =
    | { kind: 'def'; name: string; offset: number; row: number }
    | { kind: 'read'; pathText: string; offset: number };

/** Parsed file view with events and source lines. */
interface EventFile {
    events: FileEvent[];
    /** Source lines without trailing line breaks. */
    lines: string[];
}

/** Cached parse for a file path and content signature. */
interface FileCacheEntry {
    signature: string;
    file: EventFile | null;
}

/** The resolved definition shown in a hover. */
export interface ResolvedDefinition {
    /** The trimmed function definition line. */
    definitionLine: string;
    /** Comment lines directly above the definition. */
    commentLines: string[];
}

export class GapDefinitionResolver {

    private query: Query | null = null;
    private queryText: string;
    // File cache, keyed by absolute path.
    private fileCache = new Map<string, FileCacheEntry>();

    constructor(completionPath: string) {
        this.queryText = fs.readFileSync(completionPath, 'utf-8');
    }

    // Cache the parsed event list for each document version.
    private documentCache = new Map<string, { version: number; tree: Tree; events: FileEvent[] }>();

    onDocumentClosed(uri: vscode.Uri): void {
        this.fileCache.delete(uri.fsPath);
        this.documentCache.delete(uri.toString());
    }

    private getQuery(): Query {
        if (!this.query) {
            this.query = getGapLanguage().query(this.queryText);
        }
        return this.query;
    }

    /** Resolve the active definition for the given function name. */
    resolveDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition | null {
        if (!isParserReady()) return null;

        const text = document.getText();
        if (text.length > CONTENT_LENGTH_LIMIT) return null;

        const tree = getDocumentTree(document, text);
        if (!tree) return null;

        const offset = document.offsetAt(position);

        // Document events: reuse while the document version is unchanged.
        const cacheKey = document.uri.toString();
        let events: FileEvent[];
        const cached = this.documentCache.get(cacheKey);
        if (cached && cached.version === document.version && cached.tree === tree) {
            events = cached.events;
        } else {
            events = this.collectEvents(tree.rootNode, false)
                .sort((a, b) => a.offset - b.offset);
            this.documentCache.set(cacheKey, { version: document.version, tree, events });
        }
        // Only events at or before the hover offset take part.
        const relevant = events.filter(e => e.offset <= offset);

        const baseDir = this.resolveBaseDir(document);
        const names = new Set([name]);
        const start = this.scanBackwards(relevant, text.split(/\r?\n/), names, baseDir, new Set());
        return start ? this.toDefinition(start) : null;
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
                const target = this.resolveTarget(event.pathText, baseDir);
                if (!target || visited.has(target)) continue;
                visited.add(target);
                const read = this.loadFile(target);
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

    private resolveBaseDir(document: vscode.TextDocument): string | null {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        return folder ? folder.uri.fsPath : null;
    }

    /** Resolve a Read path relative to the workspace base directory. */
    private resolveTarget(pathText: string, baseDir: string): string | null {
        const trimmed = pathText.trim();
        if (!trimmed) return null;
        if (trimmed.includes('\\')) return null;
        if (path.isAbsolute(trimmed)) return trimmed;
        const candidate = path.join(baseDir, trimmed);
        return fs.existsSync(candidate) ? candidate : null;
    }

    /** Collect definition and Read events for one parsed file. */
    private collectEvents(rootNode: SyntaxNode, topLevelOnly: boolean): FileEvent[] {
        const events: FileEvent[] = [];
        for (const match of this.getQuery().matches(rootNode) as QueryMatch[]) {
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
                }
            }
            if (fnNode && !(topLevelOnly && !isTopLevel(fnNode))) {
                events.push({
                    kind: 'def',
                    name: fnNode.text,
                    offset: fnNode.startIndex,
                    row: fnNode.startPosition.row,
                });
            }
            if (readFn === 'Read' && readPath && readCall && !hasErrorAncestor(readCall)) {
                events.push({ kind: 'read', pathText: readPath, offset: readCall.endIndex });
            }
        }
        return events;
    }

    /** Read and parse one file in the nested Read chain. */
    private loadFile(filePath: string): EventFile | null {
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        let content: string;
        let signature: string;
        if (open) {
            content = open.getText();
            signature = `doc:${open.version}`;
        } else {
            try {
                const stat = fs.statSync(filePath);
                signature = `file:${stat.mtimeMs}:${stat.size}`;
                if (stat.size > CONTENT_LENGTH_LIMIT) return null;
                content = fs.readFileSync(filePath, 'utf-8');
            } catch {
                // Missing file, silently skip.
                return null;
            }
        }
        if (content.length > CONTENT_LENGTH_LIMIT) return null;

        const cached = this.fileCache.get(filePath);
        if (cached && cached.signature === signature) {
            this.fileCache.delete(filePath);
            this.fileCache.set(filePath, cached);
            return cached.file;
        }

        const file = this.parseFile(content);
        this.fileCache.delete(filePath);
        this.fileCache.set(filePath, { signature, file });
        // Bound the cache size, least recently used first.
        if (this.fileCache.size > 64) {
            const first = this.fileCache.keys().next().value;
            if (first !== undefined) this.fileCache.delete(first);
        }
        return file;
    }

    private parseFile(content: string): EventFile | null {
        const tree = parseGapCode(content);
        try {
            const events = this.collectEvents(tree.rootNode, true);
            events.sort((a, b) => a.offset - b.offset);
            return { events, lines: content.split(/\r?\n/) };
        } finally {
            tree.delete();
        }
    }
}
