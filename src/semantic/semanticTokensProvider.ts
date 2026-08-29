/**
 * GAP semantic tokens provider, uses combined viewport and global queries.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, getDocumentTreeSnapshot, isParserReady } from '../parser/gapParser';
import type { SyntaxNode } from 'web-tree-sitter';
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
import {
    SEMANTIC_CONTENT_LIMIT,
    SEMANTIC_GLOBAL_CACHE_MAX_BYTES,
    SEMANTIC_GLOBAL_CACHE_MAX_ENTRIES,
    SEMANTIC_TEXT_CACHE_MAX_BYTES,
    SEMANTIC_TEXT_CACHE_MAX_ENTRIES,
} from '../limits';
import { LruCache } from '../shared/lruCache';
import { LazyQuery } from '../shared/lazyQuery';

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

    private readonly viewportQuery: LazyQuery;
    private readonly globalQuery: LazyQuery;
    // Global data is range independent, reused across viewport requests.
    private readonly globalCache = new LruCache<string, GlobalCacheEntry>({
        maxEntries: SEMANTIC_GLOBAL_CACHE_MAX_ENTRIES,
        onEvict: (_key, entry) => { this.globalCacheBytes -= entry.estimatedBytes; },
    });
    private readonly globalFailureCache = new LruCache<string, GlobalFailureCacheEntry>({
        maxEntries: SEMANTIC_GLOBAL_CACHE_MAX_ENTRIES,
    });
    // Text snapshots avoid rereading an unchanged document on repeated viewport requests.
    private readonly textCache = new LruCache<string, TextCacheEntry>({
        maxEntries: SEMANTIC_TEXT_CACHE_MAX_ENTRIES,
        onEvict: (_key, entry) => { this.textCacheBytes -= entry.estimatedBytes; },
    });
    private globalCacheBytes = 0;
    private textCacheBytes = 0;
    private uncachedGlobalBuilds = 0;
    private readonly globalIndexMode: GlobalIndexMode;
    private globalIndexDiagnostics: GlobalIndexDiagnostics;

    private static readonly QUERY_MATCH_LIMIT = 1_000_000;
    private static readonly GLOBAL_INDEX_DIRTY_LIMIT = 0.25;
    private static readonly INDEX_RETRY_COOLDOWN_VERSIONS = 64;
    private readonly contentLengthLimit: number;
    private readonly maxGlobalCacheBytes: number;

    onDocumentClosed(uri: vscode.Uri): void {
        const key = uri.toString();
        this.globalCache.delete(key);
        this.globalFailureCache.delete(key);
        this.textCache.delete(key);
    }

    constructor(
        highlightsPath: string,
        localsPath: string,
        highlightsGlobalPath?: string,
        options: SemanticTokensProviderOptions = {},
    ) {
        this.globalIndexMode = options.globalIndexMode ?? 'disabled';
        this.contentLengthLimit = options.contentLengthLimit ?? SEMANTIC_CONTENT_LIMIT;
        this.maxGlobalCacheBytes = options.maxGlobalCacheBytes ?? SEMANTIC_GLOBAL_CACHE_MAX_BYTES;
        this.globalIndexDiagnostics = createGlobalIndexDiagnostics(this.globalIndexMode);
        const highlightsText = fs.readFileSync(highlightsPath, 'utf-8');
        const localsText = fs.readFileSync(localsPath, 'utf-8');
        const globalHighlights = highlightsGlobalPath
            ? fs.readFileSync(highlightsGlobalPath, 'utf-8')
            : highlightsText;
        this.viewportQuery = new LazyQuery(localsText + '\n' + highlightsText);
        this.globalQuery = new LazyQuery(localsText + '\n' + globalHighlights);
        console.log(`[GAP] loaded highlights.scm (${highlightsText.length} bytes), locals.scm (${localsText.length} bytes)`);
    }

    private trimGlobalCache(): void {
        while (this.globalCache.size > SEMANTIC_GLOBAL_CACHE_MAX_ENTRIES ||
            this.globalCacheBytes > this.maxGlobalCacheBytes) {
            if (!this.globalCache.evictOldest()) break;
        }
    }

    private trimTextCache(): void {
        while (this.textCache.size > SEMANTIC_TEXT_CACHE_MAX_ENTRIES ||
            this.textCacheBytes > SEMANTIC_TEXT_CACHE_MAX_BYTES) {
            if (!this.textCache.evictOldest()) break;
        }
    }

    private insertGlobalCacheEntry(key: string, entry: GlobalCacheEntry): boolean {
        this.globalCache.delete(key);
        this.globalFailureCache.delete(key);
        if (entry.estimatedBytes > this.maxGlobalCacheBytes) {
            this.uncachedGlobalBuilds++;
            return false;
        }
        this.globalCache.set(key, entry);
        this.globalCacheBytes += entry.estimatedBytes;
        this.trimGlobalCache();
        return this.globalCache.peek(key) === entry;
    }

    private insertTextCacheEntry(key: string, entry: TextCacheEntry): boolean {
        this.textCache.delete(key);
        if (entry.estimatedBytes > SEMANTIC_TEXT_CACHE_MAX_BYTES) return false;
        this.textCache.set(key, entry);
        this.textCacheBytes += entry.estimatedBytes;
        this.trimTextCache();
        return this.textCache.peek(key) === entry;
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
        const cached = this.textCache.peek(key);
        if (cached && cached.version === document.version) {
            this.textCache.touch(key, cached);
            return cached.overLimit ? null : cached.code;
        }

        this.textCache.delete(key);
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
        const query = this.globalQuery.get();
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
            const query = this.globalQuery.get();
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
        const failed = this.globalFailureCache.peek(key);
        if (failed) {
            if (failed.version === document.version && failed.generation === snapshot.generation) {
                this.globalFailureCache.touch(key, failed);
                this.globalIndexDiagnostics.globalQueryLimitCacheHits++;
                return null;
            }
            this.globalFailureCache.delete(key);
        }
        let cached = this.globalCache.peek(key);
        if (cached && cached.version === document.version && cached.generation === snapshot.generation) {
            this.globalCache.touch(key, cached);
            return cached.global;
        }
        if (cached && cached.generation === snapshot.generation) {
            cached.version = document.version;
            this.globalCache.touch(key, cached);
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
            this.globalCache.delete(key);
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
            this.globalCache.delete(key);
            this.globalFailureCache.set(key, {
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
            textBudgetBytes: SEMANTIC_TEXT_CACHE_MAX_BYTES,
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
        const viewportQuery = this.viewportQuery.get();
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
        this.viewportQuery.dispose();
        this.globalQuery.dispose();
        for (const key of [...this.globalCache.keys()]) this.globalCache.delete(key);
        this.globalFailureCache.clear();
        for (const key of [...this.textCache.keys()]) this.textCache.delete(key);
        this.uncachedGlobalBuilds = 0;
        this.globalIndexDiagnostics = createGlobalIndexDiagnostics(this.globalIndexMode);
    }

    /** Query one GAP file and return the final token entries. */
    queryEntries(code: string): TokenEntry[] {
        const tree = parseGapCode(code);
        try {
            const matches = this.viewportQuery.get().matches(tree.rootNode);
            return collectTokenEntries(code, matches);
        } finally {
            tree.delete();
        }
    }
}

