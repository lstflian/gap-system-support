/**
 * GAP semantic tokens provider, uses combined viewport and global queries.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, getDocumentTree, isParserReady, getGapLanguage } from '../parser/gapParser';
import type { Query } from 'web-tree-sitter';
import { legend } from './captureMap';
import { collectTokenEntries, collectTokenEntriesInRangeCached, buildCollectGlobal, filterViewportMatches } from './collect';
import type { CollectGlobal } from './collect';
import type { TokenEntry } from './tokens';

export { legend } from './captureMap';

export class GAPSemanticTokensProvider implements vscode.DocumentRangeSemanticTokensProvider {

    private viewportQuery: Query | null = null;
    private viewportText: string;
    private globalQuery: Query | null = null;
    private globalText: string;
    // Global data is range independent, reused across viewport requests.
    // Cached global data, keyed by version and tree identity.
    private globalCache = new Map<string, { version: number; tree: ReturnType<typeof getDocumentTree>; global: CollectGlobal }>();

    onDocumentClosed(uri: vscode.Uri): void {
        const key = uri.toString();
        this.globalCache.delete(key);
    }
    /** Over this length (UTF-16 code units) documents skip semantic tokens. */
    private static readonly CONTENT_LENGTH_LIMIT = 1 * 1024 * 1024;

    constructor(highlightsPath: string, localsPath: string, highlightsGlobalPath?: string) {
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

    private getGlobal(document: vscode.TextDocument, code: string, tree: ReturnType<typeof getDocumentTree>): CollectGlobal {
        const key = document.uri.toString();
        const cached = this.globalCache.get(key);
        if (cached && cached.version === document.version && cached.tree === tree) {
            this.globalCache.delete(key);
            this.globalCache.set(key, cached);
            return cached.global;
        }
        const matches = this.getGlobalQuery().matches(tree.rootNode);
        const global = buildCollectGlobal(code, matches);
        this.globalCache.delete(key);
        this.globalCache.set(key, { version: document.version, tree, global });
        // Bound the cache size.
        if (this.globalCache.size > 32) {
            const first = this.globalCache.keys().next().value;
            if (first !== undefined) this.globalCache.delete(first);
        }
        return global;
    }

    async provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
        cancellationToken: vscode.CancellationToken,
    ): Promise<vscode.SemanticTokens | null> {
        if (!isParserReady()) return null;

        const code = document.getText();
        // Very large documents skip semantic tokens.
        if (code.length > GAPSemanticTokensProvider.CONTENT_LENGTH_LIMIT) return null;

        const tree = getDocumentTree(document, code);

        const global = this.getGlobal(document, code, tree);
        if (cancellationToken.isCancellationRequested) return null;

        // Range query for the requested lines, must use positions not indexes.
        const matches = this.getViewportQuery().matches(tree.rootNode, {
            startPosition: { row: range.start.line, column: 0 },
            endPosition: { row: range.end.line, column: 100_000 },
        });
        if (cancellationToken.isCancellationRequested) return null;

        // Intersect semantics may return matches with no capture in range.
        const viewportMatches = filterViewportMatches(matches, range.start.line, range.end.line);
        if (cancellationToken.isCancellationRequested) return null;

        const entries = collectTokenEntriesInRangeCached(
            code, viewportMatches,
            range.start.line, range.end.line,
            global,
        );

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

