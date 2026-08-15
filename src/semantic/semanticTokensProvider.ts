/**
 * GAP semantic tokens provider, uses combined viewport and global queries.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, getDocumentTreeSnapshot, isParserReady, getGapLanguage } from '../parser/gapParser';
import type { Query, SyntaxNode } from 'web-tree-sitter';
import { legend } from './captureMap';
import { collectTokenEntries, collectTokenEntriesInRangeCached, buildCollectGlobal, filterViewportMatches, filterTokenEntriesInRange } from './collect';
import type { CollectGlobal } from './collect';
import type { TokenEntry } from './tokens';
import {
    buildGlobalTopologyIndex,
    collectGlobalsEqual,
    estimateGlobalTopologyIndexBytes,
    updateGlobalTopologyIndex,
    validateGlobalTopologyIndex,
} from './globalIndex';
import type { GlobalTopologyIndex, GlobalIndexFallbackReason } from './globalIndex';

export { legend } from './captureMap';

interface GlobalCacheEntry {
    version: number;
    generation: number;
    global: CollectGlobal;
    topology: GlobalTopologyIndex | null;
    indexRetryVersion: number;
    estimatedBytes: number;
}

interface GlobalFailureCacheEntry {
    version: number;
    generation: number;
}

type TextCacheEntry = {
    version: number;
    code: string;
    overLimit: false;
    estimatedBytes: number;
} | {
    version: number;
    overLimit: true;
    estimatedBytes: number;
};

export interface SemanticTokensCacheStats {
    globalEntries: number;
    globalFailureEntries: number;
    globalEstimatedBytes: number;
    globalBudgetBytes: number;
    uncachedGlobalBuilds: number;
    textEntries: number;
    textEstimatedBytes: number;
    textBudgetBytes: number;
    overLimitTextEntries: number;
}

export type GlobalIndexMode = 'disabled' | 'shadow' | 'enabled';

export interface SemanticTokensProviderOptions {
    globalIndexMode?: GlobalIndexMode;
    /**
     * Document length limit in UTF-16 code units.
     * Longer documents skip semantic tokens.
     */
    contentLengthLimit?: number;
    /**
     * Global cache byte budget.
     * Documents whose global data exceeds the budget are not cached.
     */
    maxGlobalCacheBytes?: number;
}

export interface GlobalIndexDiagnostics {
    mode: GlobalIndexMode;
    fullBuilds: number;
    incrementalAttempts: number;
    incrementalHits: number;
    fullFallbacks: number;
    shadowComparisons: number;
    shadowMismatches: number;
    invariantFailures: number;
    generationFallbacks: number;
    errorFallbacks: number;
    invalidTransitionFallbacks: number;
    dirtyLimitFallbacks: number;
    queryLimitFallbacks: number;
    invalidIndexFallbacks: number;
    fastPathHits: number;
    topologyBuilds: number;
    temporaryIndexBuilds: number;
    preMaterializationDirtySkips: number;
    cooldownSkips: number;
    globalQueryLimitFailures: number;
    globalQueryLimitCacheHits: number;
    lastDirtyRatio: number;
    maxDirtyRatio: number;
    lastDirtyTopLevels: number;
}

function createGlobalIndexDiagnostics(mode: GlobalIndexMode): GlobalIndexDiagnostics {
    return {
        mode,
        fullBuilds: 0,
        incrementalAttempts: 0,
        incrementalHits: 0,
        fullFallbacks: 0,
        shadowComparisons: 0,
        shadowMismatches: 0,
        invariantFailures: 0,
        generationFallbacks: 0,
        errorFallbacks: 0,
        invalidTransitionFallbacks: 0,
        dirtyLimitFallbacks: 0,
        queryLimitFallbacks: 0,
        invalidIndexFallbacks: 0,
        fastPathHits: 0,
        topologyBuilds: 0,
        temporaryIndexBuilds: 0,
        preMaterializationDirtySkips: 0,
        cooldownSkips: 0,
        globalQueryLimitFailures: 0,
        globalQueryLimitCacheHits: 0,
        lastDirtyRatio: 0,
        maxDirtyRatio: 0,
        lastDirtyTopLevels: 0,
    };
}

export class GAPSemanticTokensProvider implements vscode.DocumentRangeSemanticTokensProvider {

    private viewportQuery: Query | null = null;
    private viewportText: string;
    private globalQuery: Query | null = null;
    private globalText: string;
    // Global data is range independent, reused across viewport requests.
    private globalCache = new Map<string, GlobalCacheEntry>();
    private globalFailureCache = new Map<string, GlobalFailureCacheEntry>();
    // Text snapshots avoid rereading an unchanged document on repeated viewport requests.
    private textCache = new Map<string, TextCacheEntry>();
    private globalCacheBytes = 0;
    private textCacheBytes = 0;
    private uncachedGlobalBuilds = 0;
    private readonly globalIndexMode: GlobalIndexMode;
    private globalIndexDiagnostics: GlobalIndexDiagnostics;

    private static readonly MAX_GLOBAL_CACHE_ENTRIES = 32;
    private static readonly DEFAULT_MAX_GLOBAL_CACHE_BYTES = 256 * 1024 * 1024;
    private readonly maxGlobalCacheBytes: number;
    private static readonly MAX_TEXT_CACHE_ENTRIES = 8;
    private static readonly MAX_TEXT_CACHE_BYTES = 8 * 1024 * 1024;
    private static readonly QUERY_MATCH_LIMIT = 1_000_000;
    private static readonly GLOBAL_INDEX_DIRTY_LIMIT = 0.25;
    private static readonly INDEX_RETRY_COOLDOWN_VERSIONS = 64;
    /** Over this length (UTF-16 code units) documents skip semantic tokens. */
    private static readonly DEFAULT_CONTENT_LENGTH_LIMIT = 2 * 1024 * 1024;
    private readonly contentLengthLimit: number;

    onDocumentClosed(uri: vscode.Uri): void {
        const key = uri.toString();
        this.removeGlobalCacheEntry(key);
        this.globalFailureCache.delete(key);
        this.removeTextCacheEntry(key);
    }

    constructor(
        highlightsPath: string,
        localsPath: string,
        highlightsGlobalPath?: string,
        options: SemanticTokensProviderOptions = {},
    ) {
        this.globalIndexMode = options.globalIndexMode ?? 'disabled';
        this.contentLengthLimit = options.contentLengthLimit ??
            GAPSemanticTokensProvider.DEFAULT_CONTENT_LENGTH_LIMIT;
        this.maxGlobalCacheBytes = options.maxGlobalCacheBytes ??
            GAPSemanticTokensProvider.DEFAULT_MAX_GLOBAL_CACHE_BYTES;
        this.globalIndexDiagnostics = createGlobalIndexDiagnostics(this.globalIndexMode);
        const highlightsText = fs.readFileSync(highlightsPath, 'utf-8');
        const localsText = fs.readFileSync(localsPath, 'utf-8');
        this.viewportText = localsText + '\n' + highlightsText;
        const globalHighlights = highlightsGlobalPath
            ? fs.readFileSync(highlightsGlobalPath, 'utf-8')
            : highlightsText;
        this.globalText = localsText + '\n' + globalHighlights;
        console.log(`[GAP] loaded highlights.scm (${highlightsText.length} bytes), locals.scm (${localsText.length} bytes)`);
    }

    private getViewportQuery(): Query {
        if (!this.viewportQuery) {
            this.viewportQuery = getGapLanguage().query(this.viewportText);
        }
        return this.viewportQuery;
    }

    private getGlobalQuery(): Query {
        if (!this.globalQuery) {
            this.globalQuery = getGapLanguage().query(this.globalText);
        }
        return this.globalQuery;
    }

    private removeGlobalCacheEntry(key: string): void {
        const cached = this.globalCache.get(key);
        if (!cached) return;
        this.globalCache.delete(key);
        this.globalCacheBytes -= cached.estimatedBytes;
    }

    private removeTextCacheEntry(key: string): void {
        const cached = this.textCache.get(key);
        if (!cached) return;
        this.textCache.delete(key);
        this.textCacheBytes -= cached.estimatedBytes;
    }

    private touchGlobalCacheEntry(key: string, cached: GlobalCacheEntry): void {
        this.globalCache.delete(key);
        this.globalCache.set(key, cached);
    }

    private touchGlobalFailureCacheEntry(key: string, cached: GlobalFailureCacheEntry): void {
        this.globalFailureCache.delete(key);
        this.globalFailureCache.set(key, cached);
    }

    private touchTextCacheEntry(key: string, cached: TextCacheEntry): void {
        this.textCache.delete(key);
        this.textCache.set(key, cached);
    }

    private trimGlobalCache(): void {
        while (this.globalCache.size > GAPSemanticTokensProvider.MAX_GLOBAL_CACHE_ENTRIES ||
            this.globalCacheBytes > this.maxGlobalCacheBytes) {
            const oldest = this.globalCache.keys().next().value;
            if (oldest === undefined) break;
            this.removeGlobalCacheEntry(oldest);
        }
    }

    private insertGlobalFailureCacheEntry(key: string, entry: GlobalFailureCacheEntry): void {
        this.globalFailureCache.delete(key);
        this.globalFailureCache.set(key, entry);
        while (this.globalFailureCache.size > GAPSemanticTokensProvider.MAX_GLOBAL_CACHE_ENTRIES) {
            const oldest = this.globalFailureCache.keys().next().value;
            if (oldest === undefined) break;
            this.globalFailureCache.delete(oldest);
        }
    }

    private trimTextCache(): void {
        while (this.textCache.size > GAPSemanticTokensProvider.MAX_TEXT_CACHE_ENTRIES ||
            this.textCacheBytes > GAPSemanticTokensProvider.MAX_TEXT_CACHE_BYTES) {
            const oldest = this.textCache.keys().next().value;
            if (oldest === undefined) break;
            this.removeTextCacheEntry(oldest);
        }
    }

    private insertGlobalCacheEntry(key: string, entry: GlobalCacheEntry): boolean {
        this.removeGlobalCacheEntry(key);
        this.globalFailureCache.delete(key);
        if (entry.estimatedBytes > this.maxGlobalCacheBytes) {
            this.uncachedGlobalBuilds++;
            return false;
        }
        this.globalCache.set(key, entry);
        this.globalCacheBytes += entry.estimatedBytes;
        this.trimGlobalCache();
        return this.globalCache.get(key) === entry;
    }

    private insertTextCacheEntry(key: string, entry: TextCacheEntry): boolean {
        this.removeTextCacheEntry(key);
        if (entry.estimatedBytes > GAPSemanticTokensProvider.MAX_TEXT_CACHE_BYTES) return false;
        this.textCache.set(key, entry);
        this.textCacheBytes += entry.estimatedBytes;
        this.trimTextCache();
        return this.textCache.get(key) === entry;
    }

    private estimateGlobalBytes(
        key: string,
        global: CollectGlobal,
        topology: GlobalTopologyIndex | null,
    ): number {
        let bytes = 256 + key.length * 2;
        for (const line of global.rawLines) bytes += 24 + line.length * 2;
        bytes += 24 + global.lineLens.length * 8;
        bytes += 48 + global.finalMappingIndex.size * 112;
        bytes += 48 + global.referenceNodes.size * 32;
        bytes += 48 + global.definitionNodes.size * 32;
        for (const scope of global.scopes) {
            bytes += 96;
            for (const [name, definitions] of scope.definitions) {
                bytes += 64 + name.length * 2;
                for (const definition of definitions) {
                    bytes += 96 + definition.captureName.length * 2;
                    bytes += definition.mapping.type.length * 2;
                    for (const modifier of definition.mapping.modifiers) bytes += 24 + modifier.length * 2;
                }
            }
        }
        if (topology) bytes += estimateGlobalTopologyIndexBytes(topology);
        return bytes;
    }

    private estimateTextBytes(key: string, code?: string): number {
        return 64 + key.length * 2 + (code?.length ?? 0) * 2;
    }

    private getDocumentText(document: vscode.TextDocument): string | null {
        const key = document.uri.toString();
        const cached = this.textCache.get(key);
        if (cached && cached.version === document.version) {
            this.touchTextCacheEntry(key, cached);
            return cached.overLimit ? null : cached.code;
        }

        this.removeTextCacheEntry(key);
        const code = document.getText();
        if (code.length > this.contentLengthLimit) {
            this.insertTextCacheEntry(key, {
                version: document.version,
                overLimit: true,
                estimatedBytes: this.estimateTextBytes(key),
            });
            return null;
        }
        this.insertTextCacheEntry(key, {
            version: document.version,
            code,
            overLimit: false,
            estimatedBytes: this.estimateTextBytes(key, code),
        });
        return code;
    }

    private noteFallback(reason: GlobalIndexFallbackReason): void {
        this.globalIndexDiagnostics.fullFallbacks++;
        if (reason === 'invalid-transition' || reason === 'too-many-edits') {
            this.globalIndexDiagnostics.invalidTransitionFallbacks++;
        } else if (reason === 'dirty-limit') {
            this.globalIndexDiagnostics.dirtyLimitFallbacks++;
        } else if (reason === 'query-limit') {
            this.globalIndexDiagnostics.queryLimitFallbacks++;
        } else {
            this.globalIndexDiagnostics.invalidIndexFallbacks++;
            this.globalIndexDiagnostics.invariantFailures++;
        }
    }

    private buildFullGlobal(
        code: string,
        snapshot: ReturnType<typeof getDocumentTreeSnapshot>,
        withTopology: boolean,
    ): { global: CollectGlobal; topology: GlobalTopologyIndex | null } | null {
        const query = this.getGlobalQuery();
        const matches = query.matches(snapshot.tree.rootNode, {
            matchLimit: GAPSemanticTokensProvider.QUERY_MATCH_LIMIT,
        });
        if (query.didExceedMatchLimit()) {
            this.globalIndexDiagnostics.globalQueryLimitFailures++;
            return null;
        }
        this.globalIndexDiagnostics.fullBuilds++;
        let oracleGlobal: CollectGlobal | null = null;
        const getOracleGlobal = (): CollectGlobal => {
            if (!oracleGlobal) oracleGlobal = buildCollectGlobal(code, matches);
            return oracleGlobal;
        };
        if (!withTopology) return { global: getOracleGlobal(), topology: null };

        try {
            const global = getOracleGlobal();
            const topology = buildGlobalTopologyIndex(snapshot.tree.rootNode);
            if (validateGlobalTopologyIndex(topology, code.length)) {
                this.globalIndexDiagnostics.invariantFailures++;
                return { global, topology: null };
            }
            this.globalIndexDiagnostics.topologyBuilds++;
            return { global, topology };
        } catch {
            this.globalIndexDiagnostics.invariantFailures++;
            return { global: getOracleGlobal(), topology: null };
        }
    }

    private tryIncrementalGlobal(
        code: string,
        snapshot: ReturnType<typeof getDocumentTreeSnapshot>,
        cached: Pick<
            GlobalCacheEntry,
            'version' | 'generation' | 'global' | 'topology' | 'indexRetryVersion'
        >,
        documentVersion: number,
    ): ReturnType<typeof updateGlobalTopologyIndex> | null {
        if (this.globalIndexMode === 'disabled') return null;
        const change = snapshot.change;
        if (!cached.topology) {
            if (change && change.fromGeneration === cached.generation &&
                change.toGeneration === snapshot.generation && change.fromVersion === cached.version &&
                change.toVersion === documentVersion && change.toVersion === change.fromVersion + 1 &&
                (change.oldHasError || change.newHasError)) {
                this.globalIndexDiagnostics.errorFallbacks++;
                this.globalIndexDiagnostics.fullFallbacks++;
            }
            return null;
        }
        if (documentVersion < cached.indexRetryVersion) {
            this.globalIndexDiagnostics.cooldownSkips++;
            return null;
        }
        this.globalIndexDiagnostics.incrementalAttempts++;
        if (!change || change.fromGeneration !== cached.generation ||
            change.toGeneration !== snapshot.generation || change.fromVersion !== cached.version ||
            change.toVersion !== documentVersion || change.toVersion !== change.fromVersion + 1) {
            this.globalIndexDiagnostics.generationFallbacks++;
            this.globalIndexDiagnostics.fullFallbacks++;
            return null;
        }
        if (change.oldHasError || change.newHasError) {
            this.globalIndexDiagnostics.errorFallbacks++;
            this.globalIndexDiagnostics.fullFallbacks++;
            return null;
        }

        let result: ReturnType<typeof updateGlobalTopologyIndex>;
        try {
            const query = this.getGlobalQuery();
            result = updateGlobalTopologyIndex(
                cached.topology,
                cached.global,
                snapshot.tree.rootNode,
                code,
                change,
                (node: SyntaxNode) => {
                    const matches = query.matches(node, {
                        matchLimit: GAPSemanticTokensProvider.QUERY_MATCH_LIMIT,
                    });
                    return query.didExceedMatchLimit() ? null : matches;
                },
                GAPSemanticTokensProvider.GLOBAL_INDEX_DIRTY_LIMIT,
                this.globalIndexMode === 'shadow',
            );
        } catch {
            this.noteFallback('invalid-index');
            return null;
        }
        if (result.materializedPreviousIndex) this.globalIndexDiagnostics.temporaryIndexBuilds++;
        if (result.status === 'fallback' && result.reason === 'dirty-limit' &&
            !result.materializedPreviousIndex) {
            this.globalIndexDiagnostics.preMaterializationDirtySkips++;
        }
        this.globalIndexDiagnostics.lastDirtyRatio = result.dirtyRatio;
        this.globalIndexDiagnostics.maxDirtyRatio = Math.max(
            this.globalIndexDiagnostics.maxDirtyRatio,
            result.dirtyRatio,
        );
        if (result.status === 'fallback') {
            this.globalIndexDiagnostics.lastDirtyTopLevels = 0;
            this.noteFallback(result.reason);
            return result;
        }
        this.globalIndexDiagnostics.lastDirtyTopLevels = result.dirtyTopLevels;
        if (result.reusedGlobalIndex) this.globalIndexDiagnostics.fastPathHits++;
        return result;
    }

    private getGlobal(
        document: vscode.TextDocument,
        code: string,
        snapshot: ReturnType<typeof getDocumentTreeSnapshot>,
    ): CollectGlobal | null {
        const key = document.uri.toString();
        const failed = this.globalFailureCache.get(key);
        if (failed) {
            if (failed.version === document.version && failed.generation === snapshot.generation) {
                this.touchGlobalFailureCacheEntry(key, failed);
                this.globalIndexDiagnostics.globalQueryLimitCacheHits++;
                return null;
            }
            this.globalFailureCache.delete(key);
        }
        let cached = this.globalCache.get(key);
        if (cached && cached.version === document.version && cached.generation === snapshot.generation) {
            this.touchGlobalCacheEntry(key, cached);
            return cached.global;
        }
        if (cached && cached.generation === snapshot.generation) {
            cached.version = document.version;
            this.touchGlobalCacheEntry(key, cached);
            return cached.global;
        }

        const previous = cached ? {
            version: cached.version,
            generation: cached.generation,
            global: cached.global,
            topology: cached.topology,
            indexRetryVersion: cached.indexRetryVersion,
            estimatedBytes: cached.estimatedBytes,
        } : null;
        if (cached) {
            this.removeGlobalCacheEntry(key);
            cached = undefined;
        }
        const incremental = previous
            ? this.tryIncrementalGlobal(code, snapshot, previous, document.version)
            : null;
        if (incremental?.status === 'updated' && this.globalIndexMode === 'enabled') {
            this.globalIndexDiagnostics.incrementalHits++;
            const estimatedBytes = incremental.reusedGlobalIndex && previous?.global
                ? previous.estimatedBytes +
                    (incremental.global.rawLines.length - previous.global.rawLines.length) * 30
                : this.estimateGlobalBytes(key, incremental.global, incremental.index);
            const entry: GlobalCacheEntry = {
                version: document.version,
                generation: snapshot.generation,
                global: incremental.global,
                topology: incremental.index,
                indexRetryVersion: 0,
                estimatedBytes,
            };
            this.insertGlobalCacheEntry(key, entry);
            return incremental.global;
        }

        let indexRetryVersion = previous?.indexRetryVersion ?? 0;
        if (incremental?.status === 'fallback' && incremental.reason === 'dirty-limit') {
            indexRetryVersion = document.version + GAPSemanticTokensProvider.INDEX_RETRY_COOLDOWN_VERSIONS;
        }
        const treeHasError = snapshot.tree.rootNode.hasError;
        if (treeHasError && this.globalIndexMode !== 'disabled') {
            indexRetryVersion = Math.max(indexRetryVersion, document.version + 1);
        }
        const shouldBuildTopology = this.globalIndexMode !== 'disabled' && !treeHasError;
        const full = this.buildFullGlobal(
            code,
            snapshot,
            shouldBuildTopology,
        );
        if (!full) {
            this.removeGlobalCacheEntry(key);
            this.insertGlobalFailureCacheEntry(key, {
                version: document.version,
                generation: snapshot.generation,
            });
            return null;
        }

        let topology = full.topology;
        if (incremental?.status === 'updated' && this.globalIndexMode === 'shadow') {
            this.globalIndexDiagnostics.shadowComparisons++;
            if (collectGlobalsEqual(full.global, incremental.global)) {
                this.globalIndexDiagnostics.incrementalHits++;
                topology = incremental.index;
            } else {
                this.globalIndexDiagnostics.shadowMismatches++;
                this.globalIndexDiagnostics.invariantFailures++;
                this.globalIndexDiagnostics.fullFallbacks++;
            }
        }

        if (topology && document.version >= indexRetryVersion) {
            indexRetryVersion = 0;
        }

        const estimatedBytes = incremental?.status === 'updated' && incremental.reusedGlobalIndex &&
            topology === incremental.index && previous?.global
            ? previous.estimatedBytes +
                (full.global.rawLines.length - previous.global.rawLines.length) * 30
            : this.estimateGlobalBytes(key, full.global, topology);
        this.insertGlobalCacheEntry(key, {
            version: document.version,
            generation: snapshot.generation,
            global: full.global,
            topology,
            indexRetryVersion,
            estimatedBytes,
        });
        return full.global;
    }

    getCacheStats(): SemanticTokensCacheStats {
        let overLimitTextEntries = 0;
        for (const entry of this.textCache.values()) {
            if (entry.overLimit) overLimitTextEntries++;
        }
        return {
            globalEntries: this.globalCache.size,
            globalFailureEntries: this.globalFailureCache.size,
            globalEstimatedBytes: this.globalCacheBytes,
            globalBudgetBytes: this.maxGlobalCacheBytes,
            uncachedGlobalBuilds: this.uncachedGlobalBuilds,
            textEntries: this.textCache.size,
            textEstimatedBytes: this.textCacheBytes,
            textBudgetBytes: GAPSemanticTokensProvider.MAX_TEXT_CACHE_BYTES,
            overLimitTextEntries,
        };
    }

    getGlobalIndexDiagnostics(): GlobalIndexDiagnostics {
        return { ...this.globalIndexDiagnostics };
    }

    async provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
        cancellationToken: vscode.CancellationToken,
    ): Promise<vscode.SemanticTokens | null> {
        if (cancellationToken.isCancellationRequested) return null;
        if (!isParserReady()) return null;

        if (range.start.line > range.end.line ||
            (range.start.line === range.end.line && range.start.character >= range.end.character)) {
            return new vscode.SemanticTokensBuilder(legend).build();
        }

        const code = this.getDocumentText(document);
        if (code === null) return null;
        if (cancellationToken.isCancellationRequested) return null;

        const snapshot = getDocumentTreeSnapshot(document, code);
        if (cancellationToken.isCancellationRequested) return null;

        const global = this.getGlobal(document, code, snapshot);
        if (!global) return null;
        if (cancellationToken.isCancellationRequested) return null;

        const lastLine = global.rawLines.length - 1;
        if (range.start.line > lastLine || range.end.line < 0) {
            return new vscode.SemanticTokensBuilder(legend).build();
        }
        // Query one line around the request, then apply the exact range filter below.
        const queryStartLine = Math.max(0, range.start.line - 1);
        const queryEndLine = Math.min(lastLine, range.end.line + 1);
        const queryEndColumn = global.lineLens[queryEndLine] ?? 0;
        const viewportQuery = this.getViewportQuery();
        const matches = viewportQuery.matches(snapshot.tree.rootNode, {
            startPosition: { row: queryStartLine, column: 0 },
            endPosition: { row: queryEndLine, column: queryEndColumn },
            matchLimit: GAPSemanticTokensProvider.QUERY_MATCH_LIMIT,
        });
        if (viewportQuery.didExceedMatchLimit()) return null;
        if (cancellationToken.isCancellationRequested) return null;

        // Intersect semantics may return matches with no capture in range.
        const viewportMatches = filterViewportMatches(matches, queryStartLine, queryEndLine);
        if (cancellationToken.isCancellationRequested) return null;

        const entries = filterTokenEntriesInRange(collectTokenEntriesInRangeCached(
            code, viewportMatches,
            queryStartLine, queryEndLine,
            global,
            false,
        ), range);

        const builder = new vscode.SemanticTokensBuilder(legend);
        for (const entry of entries) {
            if (cancellationToken.isCancellationRequested) return null;
            // Punctuation and spell entries have no mapping, skip them.
            if (entry.type === null) continue;
            builder.push(
                new vscode.Range(entry.line, entry.col, entry.line, entry.col + entry.text.length),
                entry.type,
                entry.modifiers,
            );
        }

        return builder.build();
    }

    dispose(): void {
        this.viewportQuery?.delete();
        this.globalQuery?.delete();
        this.viewportQuery = null;
        this.globalQuery = null;
        for (const key of [...this.globalCache.keys()]) this.removeGlobalCacheEntry(key);
        this.globalFailureCache.clear();
        for (const key of [...this.textCache.keys()]) this.removeTextCacheEntry(key);
        this.uncachedGlobalBuilds = 0;
        this.globalIndexDiagnostics = createGlobalIndexDiagnostics(this.globalIndexMode);
    }

    /** Query one GAP file and return the final token entries. */
    queryEntries(code: string): TokenEntry[] {
        const tree = parseGapCode(code);
        try {
            const matches = this.getViewportQuery().matches(tree.rootNode);
            return collectTokenEntries(code, matches);
        } finally {
            tree.delete();
        }
    }
}

