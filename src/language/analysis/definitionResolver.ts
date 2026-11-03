import * as fs from 'fs';
import * as path from 'path';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { HOVER_DOCUMENT_CACHE_MAX_ENTRIES, READ_CONTENT_LIMIT } from '../../limits';
import { LruCache } from '../../shared/lruCache';
import type { LanguageHost, SourceDocument, SourcePosition, SourceUri } from '../documents';
import { getDocumentTree, isParserReady, parseGapCode } from '../parser/gapParser';
import { BindingAnalysis, type BindingFacts } from './bindings';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from './readFileCache';
import { GLOBAL_SCOPE, visibleScopeStarts } from './scopes';
import { collectSymbolDefinitions, type DefinitionSymbolKind } from './symbols';

export type { DefinitionSymbolKind } from './symbols';

const WORKSPACE_SYMBOL_CACHE_MS = 5000;

type FileEvent =
    | {
        kind: 'def';
        name: string;
        offset: number;
        end: number;
        /** Start index of the enclosing scope, -1 for the global scope. */
        scope: number;
        row: number;
        /** Column of the definition name, zero-based. */
        column: number;
        /**
         * The function header text from the syntax tree.
         * Null for lambdas and definitions without a parameter list.
         */
        headerText: string | null;
        symbolKind: DefinitionSymbolKind;
        role: 'local' | 'declaration' | 'implementation';
    }
    | { kind: 'read'; pathText: string; offset: number };

/** Parsed file view with events and source lines. */
interface EventFile {
    events: FileEvent[];
    /** Source lines without trailing line breaks. */
    lines: string[];
}

export interface ResolvedDefinition {
    definitionLine: string;
    commentLines: string[];
    filePath: string;
    /** Row of the definition line, zero-based. */
    row: number;
    /** Column of the definition name, zero-based. */
    column: number;
    symbolKind?: DefinitionSymbolKind;
}

interface WorkspaceSymbolCacheEntry {
    expiresAt: number;
    results: {
        event: Extract<FileEvent, { kind: 'def' }>;
        lines: string[];
        filePath: string;
    }[];
}

export class GAPDefinitionResolver {

    private readonly analysis: BindingAnalysis;
    private readonly ownsAnalysis: boolean;
    private readonly fileCache: ReadChainFileCache<EventFile>;

    constructor(completionPath: string, private readonly host: LanguageHost, analysis?: BindingAnalysis) {
        this.fileCache = new ReadChainFileCache(content => this.parseFile(content), host);
        this.analysis = analysis ?? new BindingAnalysis(completionPath);
        this.ownsAnalysis = analysis === undefined;
    }

    // Cache the parsed event list and source lines for each document version.
    private documentCache = new LruCache<
        string,
        { version: number; tree: Tree; events: FileEvent[]; scopeByStart: Set<number>; lines: string[] }
    >({ maxEntries: HOVER_DOCUMENT_CACHE_MAX_ENTRIES });
    private readonly workspaceSymbolCache = new Map<string, WorkspaceSymbolCacheEntry>();

    onDocumentClosed(uri: SourceUri): void {
        this.analysis.onDocumentClosed(uri);
        this.fileCache.onDocumentClosed(uri);
        this.documentCache.delete(uri.toString());
    }

    dispose(): void {
        if (this.ownsAnalysis) this.analysis.dispose();
        this.fileCache.dispose();
        this.documentCache.clear();
        this.workspaceSymbolCache.clear();
    }

    onWorkspaceFilesChanged(): void {
        this.workspaceSymbolCache.clear();
    }

    resolveDefinition(
        document: SourceDocument,
        position: SourcePosition,
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
            const collected = this.collectEvents(tree.rootNode, false, this.analysis.getDocument(document, tree));
            events = collected.events.sort((a, b) => a.offset - b.offset);
            scopeByStart = collected.scopeByStart;
            lines = text.split(/\r?\n/);
            this.documentCache.set(cacheKey, { version: document.version, tree, events, scopeByStart, lines });
        }

        const baseDir = resolveReadBaseDir(document, this.host);
        // Untitled documents have no real file: no Go to Definition link.
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;

        // Phase 0: hovering the definition's own name shows that definition.
        for (const event of events) {
            if (event.kind === 'def' && event.name === name && event.offset <= offset && offset <= event.end) {
                return this.toDefinition({ lines, row: event.row, column: event.column, filePath: currentFilePath, headerText: event.headerText, name: event.name, symbolKind: event.symbolKind });
            }
        }

        // Phase 1: scoped lookup, the same visibility rules as scoped completion.
        const visible = new Set(visibleScopeStarts(tree.rootNode, offset, scopeByStart));
        const scoped = events.filter(
            (e): e is Extract<FileEvent, { kind: 'def' }> =>
                e.kind === 'def' && visible.has(e.scope) && e.end < offset,
        );
        const scopedHit = this.pickLatestByName(scoped, name);
        if (scopedHit) {
            return this.toDefinition({ lines, row: scopedHit.row, column: scopedHit.column, filePath: currentFilePath, headerText: scopedHit.headerText, name: scopedHit.name, symbolKind: scopedHit.symbolKind });
        }

        // Phase 2: global fallback over Read chains and remaining global events.
        // Only events at or before the hover offset take part; Read events keep the chain order.
        const globalScan = events.filter(
            e => e.offset <= offset && (e.kind === 'read' || e.scope === GLOBAL_SCOPE),
        );
        const start = this.scanBackwards(globalScan, lines, new Set([name]), baseDir, new Set(), currentFilePath);
        return start ? this.toDefinition(start) : null;
    }

    /**
     * Resolve a symbol from Read calls that occur later in the current file.
     * This is useful for guards such as `if not IsBound(name) then`, where the
     * guarded bootstrap intentionally loads the definition after the check.
     */
    resolveDefinitionFromFutureReads(
        document: SourceDocument,
        position: SourcePosition,
        name: string,
    ): ResolvedDefinition | null {
        if (!isParserReady()) return null;
        const text = document.getText();
        if (text.length > READ_CONTENT_LIMIT) return null;
        const tree = getDocumentTree(document, text);
        if (!tree) return null;

        const cacheKey = document.uri.toString();
        let events: FileEvent[];
        const cached = this.documentCache.peek(cacheKey);
        if (cached && cached.version === document.version && cached.tree === tree) {
            this.documentCache.touch(cacheKey, cached);
            events = cached.events;
        } else {
            const collected = this.collectEvents(tree.rootNode, false, this.analysis.getDocument(document, tree));
            events = collected.events.sort((left, right) => left.offset - right.offset);
            this.documentCache.set(cacheKey, {
                version: document.version,
                tree,
                events,
                scopeByStart: collected.scopeByStart,
                lines: text.split(/\r?\n/),
            });
        }
        const offset = document.offsetAt(position);
        const baseDir = resolveReadBaseDir(document, this.host);
        if (!baseDir) return null;
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const visited = new Set<string>();

        for (const event of events) {
            if (event.kind !== 'read' || event.offset <= offset) continue;
            const target = resolveReadTarget(event.pathText, baseDir);
            if (!target || visited.has(target)) continue;
            visited.add(target);
            const read = this.fileCache.loadFile(target);
            if (!read) continue;
            const candidate = this.scanBackwards(
                read.events,
                read.lines,
                new Set([name]),
                baseDir,
                visited,
                target,
            );
            if (candidate) {
                return this.toDefinition({
                    lines: candidate.lines,
                    row: candidate.row,
                    column: candidate.column,
                    filePath: candidate.filePath || currentFilePath,
                    headerText: candidate.headerText,
                    name: candidate.name,
                    symbolKind: candidate.symbolKind,
                });
            }
        }
        return null;
    }

    resolveWorkspaceDefinition(
        document: SourceDocument,
        name: string,
    ): ResolvedDefinition | null {
        const baseDir = resolveReadBaseDir(document, this.host);
        if (!baseDir) return null;
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const candidate = this.scanWorkspaceSymbolDefinitionsCached(
            baseDir,
            name,
            currentFilePath,
        )[0];
        return candidate ? this.toDefinition({
            lines: candidate.lines,
            row: candidate.event.row,
            column: candidate.event.column,
            filePath: candidate.filePath,
            headerText: candidate.event.headerText,
            name: candidate.event.name,
            symbolKind: candidate.event.symbolKind,
        }) : null;
    }

    resolveDefinitions(
        document: SourceDocument,
        position: SourcePosition,
        name: string,
    ): ResolvedDefinition[] {
        const symbolDefinitions = this.resolveSymbolDefinitions(document, position, name);
        if (symbolDefinitions.length > 0) return symbolDefinitions;
        const definition = this.resolveDefinition(document, position, name);
        return definition ? [definition] : [];
    }

    private resolveSymbolDefinitions(
        document: SourceDocument,
        position: SourcePosition,
        name: string,
    ): ResolvedDefinition[] {
        const text = document.getText();
        if (!isParserReady() || text.length > READ_CONTENT_LIMIT) return [];

        const tree = getDocumentTree(document, text);
        if (!tree) return [];

        const cacheKey = document.uri.toString();
        let events: FileEvent[];
        let lines: string[];
        const cached = this.documentCache.peek(cacheKey);
        if (cached && cached.version === document.version && cached.tree === tree) {
            this.documentCache.touch(cacheKey, cached);
            events = cached.events;
            lines = cached.lines;
        } else {
            const collected = this.collectEvents(tree.rootNode, false, this.analysis.getDocument(document, tree));
            events = collected.events.sort((left, right) => left.offset - right.offset);
            lines = text.split(/\r?\n/);
            this.documentCache.set(cacheKey, {
                version: document.version,
                tree,
                events,
                scopeByStart: collected.scopeByStart,
                lines,
            });
        }
        const baseDir = resolveReadBaseDir(document, this.host);
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const offset = document.offsetAt(position);
        const candidates = this.scanAllSymbolDefinitions(
            events,
            lines,
            name,
            offset,
            baseDir,
            new Set(),
            currentFilePath,
            true,
        );
        if (candidates.length === 0 && baseDir) {
            candidates.push(...this.scanWorkspaceSymbolDefinitionsCached(
                baseDir,
                name,
                currentFilePath,
            ));
        }

        const seen = new Set<string>();
        return candidates
            .filter(candidate => {
                const key = `${candidate.filePath}:${candidate.event.row}:${candidate.event.column}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((left, right) => {
                const roleOrder = (role: 'local' | 'declaration' | 'implementation') =>
                    role === 'implementation' ? 0 : role === 'declaration' ? 1 : 2;
                return roleOrder(left.event.role) - roleOrder(right.event.role) ||
                    left.filePath.localeCompare(right.filePath) ||
                    left.event.row - right.event.row ||
                    left.event.column - right.event.column;
            })
            .map(candidate => this.toDefinition({
                lines: candidate.lines,
                row: candidate.event.row,
                column: candidate.event.column,
                filePath: candidate.filePath,
                headerText: candidate.event.headerText,
                name: candidate.event.name,
                symbolKind: candidate.event.symbolKind,
            }));
    }

    private scanWorkspaceSymbolDefinitionsCached(
        baseDir: string,
        name: string,
        currentFilePath: string,
    ): {
        event: Extract<FileEvent, { kind: 'def' }>;
        lines: string[];
        filePath: string;
    }[] {
        const key = `${baseDir}\0${name}`;
        const now = Date.now();
        const cached = this.workspaceSymbolCache.get(key);
        if (cached && cached.expiresAt > now) return cached.results;
        const results = this.scanWorkspaceSymbolDefinitions(baseDir, name, currentFilePath);
        this.workspaceSymbolCache.set(key, {
            expiresAt: now + WORKSPACE_SYMBOL_CACHE_MS,
            results,
        });
        return results;
    }

    /** Find top-level user definitions in sibling GAP source files. */
    private scanWorkspaceSymbolDefinitions(
        baseDir: string,
        name: string,
        currentFilePath: string,
    ): { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] {
        const results: { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] = [];
        const visited = new Set<string>();
        const sourceExtensions = new Set(['.g', '.gd', '.gi', '.gap']);

        const visit = (directory: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') continue;
                const filePath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    visit(filePath);
                    continue;
                }
                if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
                if (filePath === currentFilePath || visited.has(filePath)) continue;
                visited.add(filePath);
                const read = this.fileCache.loadFile(filePath);
                if (!read) continue;
                for (const event of read.events) {
                    if (event.kind === 'def' && event.name === name && event.scope === GLOBAL_SCOPE) {
                        results.push({ event, lines: read.lines, filePath });
                    }
                }
            }
        };

        visit(baseDir);
        return results;
    }

    private scanAllSymbolDefinitions(
        events: FileEvent[],
        lines: string[],
        name: string,
        maxOffset: number,
        baseDir: string | null,
        visited: Set<string>,
        currentFilePath: string,
        currentFile: boolean,
    ): { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] {
        const results: { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] = [];
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event.kind === 'def') {
                if (event.role !== 'local' &&
                    event.name === name &&
                    (!currentFile || event.offset <= maxOffset)) {
                    results.push({ event, lines, filePath: currentFilePath });
                }
                continue;
            }

            if (!baseDir || (currentFile && event.offset > maxOffset)) continue;
            const target = resolveReadTarget(event.pathText, baseDir);
            if (!target || visited.has(target)) continue;
            visited.add(target);
            const read = this.fileCache.loadFile(target);
            if (!read) continue;
            results.push(...this.scanAllSymbolDefinitions(
                read.events,
                read.lines,
                name,
                Number.POSITIVE_INFINITY,
                baseDir,
                visited,
                target,
                false,
            ));
        }
        return results;
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

    private scanBackwards(
        events: FileEvent[],
        lines: string[],
        names: Set<string>,
        baseDir: string | null,
        visited: Set<string>,
        currentFilePath: string,
    ): {
        lines: string[];
        row: number;
        column: number;
        filePath: string;
        headerText: string | null;
        name: string;
        symbolKind: DefinitionSymbolKind;
    } | null {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.kind === 'def') {
                if (names.has(event.name)) {
                    return { lines, row: event.row, column: event.column, filePath: currentFilePath, headerText: event.headerText, name: event.name, symbolKind: event.symbolKind };
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

    private toDefinition(start: {
        lines: string[];
        row: number;
        column: number;
        filePath: string;
        headerText: string | null;
        name: string;
        symbolKind?: DefinitionSymbolKind;
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
        return {
            definitionLine,
            commentLines,
            filePath: start.filePath,
            row: start.row,
            column: start.column,
            symbolKind: start.symbolKind,
        };
    }

    private collectEvents(
        rootNode: SyntaxNode, topLevelOnly: boolean, facts: BindingFacts = this.analysis.collect(rootNode),
    ): { events: FileEvent[]; scopeByStart: Set<number> } {
        const events: FileEvent[] = facts.readCalls.map(call => ({ kind: 'read', pathText: call.path, offset: call.end }));
        const definitions = new Map<string, Extract<FileEvent, { kind: 'def' }>>();
        for (const binding of facts.bindings) {
            if (topLevelOnly && binding.scope !== GLOBAL_SCOPE) continue;
            definitions.set(`${binding.start}:${binding.end}`, {
                kind: 'def', name: binding.name, offset: binding.start, end: binding.end, scope: binding.scope,
                row: binding.position.line, column: binding.position.character,
                headerText: binding.headerText, symbolKind: binding.kind, role: 'local',
            });
        }
        const symbols = collectSymbolDefinitions(rootNode);
        for (const member of symbols.members) {
            if (topLevelOnly && member.scope !== GLOBAL_SCOPE) continue;
            const key = `${member.start}:${member.end}`;
            if (definitions.has(key)) continue;
            definitions.set(key, {
                kind: 'def', name: member.name, offset: member.start, end: member.end, scope: member.scope,
                row: member.position.line, column: member.position.character,
                headerText: null, symbolKind: member.kind, role: 'local',
            });
        }
        events.push(...definitions.values());
        for (const symbol of symbols.declarations) {
            events.push({
                kind: 'def', name: symbol.name, offset: symbol.start, end: symbol.end, scope: symbol.scope,
                row: symbol.position.line, column: symbol.position.character,
                headerText: null, symbolKind: symbol.kind, role: symbol.role,
            });
        }
        return { events, scopeByStart: new Set(facts.scopeByStart.keys()) };
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
