/**
 * Builds the scope table and token entries from combined query matches.
 */

import type { QueryMatch, SyntaxNode } from 'web-tree-sitter';
import { posOuter, byteKey } from './keys';
import { CAPTURE_MAP, isDefinitionLikeCapture } from './captureMap';
import type { TokenMapping } from './captureMap';
import { buildScopes, findDefinition, hasErrorAncestor, CAPTURE_KIND } from './locals';
import type { ScopeEntry } from './locals';
import { splitOverlapping, filterNullTokens } from './tokens';
import type { InternalToken, DeferredToken, TokenEntry, CombinedData } from './tokens';

/**
 * One pass over the matches, locals feed scopes and highlights feed tokens.
 * Same start position keeps the larger pattern index.
 */
function singlePassCollect(
    combinedMatches: QueryMatch[],
): CombinedData {
    const tokenMap = new Map<number, InternalToken>();
    const nullMap = new Map<number, InternalToken>();
    const finalIndex = new Map<number, { pattern: number; mapping: TokenMapping; captureName: string }>();
    const referenceNodes = new Set<number>();
    const definitionNodes = new Set<number>();
    const scopeNodes: SyntaxNode[] = [];
    const definitions: SyntaxNode[] = [];

    for (const match of combinedMatches) {
        for (const capture of match.captures) {
            const node = capture.node;
            const name = capture.name;

            // Locals always kept, the scope table must be global.
            if (name === 'local.scope') {
                if (hasErrorAncestor(node)) continue;
                scopeNodes.push(node);
                continue;
            }
            if (CAPTURE_KIND[name]) {
                // Record fields are not variables in GAP.
                // Keep them out of the scope table, or a same-name reference resolves to the field.
                if (CAPTURE_KIND[name] !== 'field') {
                    definitionNodes.add(byteKey(node.startIndex, node.endIndex));
                    definitions.push(node);
                }
                continue;
            }
            if (name === 'local.reference') {
                referenceNodes.add(byteKey(node.startIndex, node.endIndex));
                continue;
            }

            const rawMapping = CAPTURE_MAP[name];

            if (name === 'variable.parameter' || name === 'variable.parameter.builtin') {
                if (hasErrorAncestor(node)) continue;
            }

            if (rawMapping && isDefinitionLikeCapture(name)) {
                const bkey = byteKey(node.startIndex, node.endIndex);
                const existingIdx = finalIndex.get(bkey);
                if (!existingIdx || match.pattern > existingIdx.pattern) {
                    finalIndex.set(bkey, { pattern: match.pattern, mapping: rawMapping, captureName: name });
                }
            }

            const sp = node.startPosition;
            const ep = node.endPosition;
            const sl = sp.row;
            const sc = sp.column;
            const el = ep.row;
            const ec = ep.column;

            const ok = posOuter(sl, sc);

            if (!rawMapping) {
                const existingNull = nullMap.get(ok);
                if (!existingNull || match.pattern > existingNull.pattern) {
                    nullMap.set(ok, { pattern: match.pattern, sl, sc, el, ec, startIndex: node.startIndex, endIndex: node.endIndex, type: null, modifiers: [], captureName: name });
                }
                continue;
            }

            const existing = tokenMap.get(ok);
            if (!existing || match.pattern > existing.pattern) {
                tokenMap.set(ok, {
                    pattern: match.pattern,
                    sl, sc, el, ec,
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    type: rawMapping.type,
                    modifiers: rawMapping.modifiers,
                    captureName: name,
                });
            }
        }
    }

    // Strip the pattern index; buildScopes reads the plain mapping.
    // The pattern stays in finalIndex for conflict resolution.
    const finalMappingIndex = new Map<number, { mapping: TokenMapping; captureName: string }>();
    for (const [k, v] of finalIndex) finalMappingIndex.set(k, { mapping: v.mapping, captureName: v.captureName });

    return { tokenMap, nullMap, finalMappingIndex, referenceNodes, definitionNodes, scopeNodes, definitions };
}

export interface GlobalCollectData {
    finalMappingIndex: Map<number, { mapping: TokenMapping; captureName: string }>;
    referenceNodes: Set<number>;
    definitionNodes: Set<number>;
    scopeNodes: SyntaxNode[];
    definitions: SyntaxNode[];
}

/**
 * The global data is independent of any viewport range.
 */
export function singlePassCollectGlobal(
    combinedMatches: QueryMatch[],
): GlobalCollectData {
    const finalIndex = new Map<number, { pattern: number; mapping: TokenMapping; captureName: string }>();
    const referenceNodes = new Set<number>();
    const definitionNodes = new Set<number>();
    const scopeNodes: SyntaxNode[] = [];
    const definitions: SyntaxNode[] = [];

    for (const match of combinedMatches) {
        for (const capture of match.captures) {
            const node = capture.node;
            const name = capture.name;

            if (name === 'local.scope') {
                if (hasErrorAncestor(node)) continue;
                scopeNodes.push(node);
                continue;
            }
            if (CAPTURE_KIND[name]) {
                // Record fields are not variables in GAP.
                // Keep them out of the scope table, or a same-name reference resolves to the field.
                if (CAPTURE_KIND[name] !== 'field') {
                    definitionNodes.add(byteKey(node.startIndex, node.endIndex));
                    definitions.push(node);
                }
                continue;
            }
            if (name === 'local.reference') {
                referenceNodes.add(byteKey(node.startIndex, node.endIndex));
                continue;
            }

            const rawMapping = CAPTURE_MAP[name];

            if (name === 'variable.parameter' || name === 'variable.parameter.builtin') {
                if (hasErrorAncestor(node)) continue;
            }

            if (!rawMapping || !isDefinitionLikeCapture(name)) continue;
            const bkey = byteKey(node.startIndex, node.endIndex);
            const existingIdx = finalIndex.get(bkey);
            if (!existingIdx || match.pattern > existingIdx.pattern) {
                finalIndex.set(bkey, { pattern: match.pattern, mapping: rawMapping, captureName: name });
            }
        }
    }

    const finalMappingIndex = new Map<number, { mapping: TokenMapping; captureName: string }>();
    for (const [k, v] of finalIndex) finalMappingIndex.set(k, { mapping: v.mapping, captureName: v.captureName });

    return { finalMappingIndex, referenceNodes, definitionNodes, scopeNodes, definitions };
}

/** Global (range independent) collect data, cacheable across viewport requests. */
export interface CollectGlobal {
    finalMappingIndex: CombinedData['finalMappingIndex'];
    referenceNodes: CombinedData['referenceNodes'];
    definitionNodes: CombinedData['definitionNodes'];
    scopes: ScopeEntry[];
    rawLines: string[];
    lineLens: number[];
}

/**
 * Build the range independent global data, cacheable by document version.
 */
export function buildCollectGlobal(code: string, matches: QueryMatch[]): CollectGlobal {
    const data = singlePassCollectGlobal(matches);
    const scopes = buildScopes(data);
    const rawLines = code.split('\n');
    const lineLens = rawLines.map(l => l.endsWith('\r') ? l.length - 1 : l.length);
    return {
        finalMappingIndex: data.finalMappingIndex,
        referenceNodes: data.referenceNodes,
        definitionNodes: data.definitionNodes,
        scopes,
        rawLines,
        lineLens,
    };
}

export function filterViewportMatches(
    matches: QueryMatch[],
    startLine: number,
    endLine: number,
): QueryMatch[] {
    return matches.filter(m =>
        m.captures.some(c => {
            const sp = c.node.startPosition;
            if (sp.row > endLine) return false;
            const ep = c.node.endPosition;
            return ep.row >= startLine;
        }));
}

/**
 * Run the token pipeline restricted to a line range, reusing a cached global.
 */
export function collectTokenEntriesInRangeCached(
    code: string,
    matches: QueryMatch[],
    startLine: number,
    endLine: number,
    global: CollectGlobal,
    includeNullTokens = true,
): TokenEntry[] {
    const data = collectViewportTokens(matches, startLine, endLine, global, includeNullTokens);
    const entries = finishEntries(code, data, global.scopes, global.rawLines, global.lineLens);
    // Keep only segments on the requested lines.
    return entries.filter(e => e.line >= startLine && e.line <= endLine);
}

/**
 * Keep complete single-line tokens that intersect a VS Code range.
 * LSP allows a boundary token to extend beyond the requested range.
 */
export function filterTokenEntriesInRange(
    entries: TokenEntry[],
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
): TokenEntry[] {
    const startLine = range.start.line;
    const startCharacter = range.start.character;
    const endLine = range.end.line;
    const endCharacter = range.end.character;
    if (startLine > endLine || (startLine === endLine && startCharacter >= endCharacter)) {
        return [];
    }

    return entries.filter(entry => {
        if (entry.line < startLine || entry.line > endLine) return false;
        const tokenEnd = entry.col + entry.text.length;
        if (entry.line === startLine && tokenEnd <= startCharacter) return false;
        if (entry.line === endLine && entry.col >= endCharacter) return false;
        return true;
    });
}

/**
 * Collect viewport intersecting highlight captures into fresh token maps.
 * The global sets are shared from the cached global data.
 */
function collectViewportTokens(
    matches: QueryMatch[],
    startLine: number,
    endLine: number,
    global: CollectGlobal,
    includeNullTokens: boolean,
): CombinedData {
    const tokenMap = new Map<number, InternalToken>();
    const nullMap = new Map<number, InternalToken>();

    for (const match of matches) {
        for (const capture of match.captures) {
            const node = capture.node;
            const name = capture.name;

            // Locals are handled by the global, skip them here.
            if (name === 'local.scope') continue;
            if (CAPTURE_KIND[name]) continue;
            if (name === 'local.reference') continue;

            const rawMapping = CAPTURE_MAP[name];

            // Skip parameter captures inside ERROR subtrees.
            if (name === 'variable.parameter' || name === 'variable.parameter.builtin') {
                if (hasErrorAncestor(node)) continue;
            }

            // Read the start position first, reject rows past the viewport.
            const sp = node.startPosition;
            const sl = sp.row;
            const sc = sp.column;
            if (sl > endLine) continue;
            const ep = node.endPosition;
            const el = ep.row;
            const ec = ep.column;
            if (el < startLine) continue;

            const ok = posOuter(sl, sc);

            if (!rawMapping) {
                if (!includeNullTokens) continue;
                const existingNull = nullMap.get(ok);
                if (!existingNull || match.pattern > existingNull.pattern) {
                    nullMap.set(ok, { pattern: match.pattern, sl, sc, el, ec, startIndex: node.startIndex, endIndex: node.endIndex, type: null, modifiers: [], captureName: name });
                }
                continue;
            }

            const existing = tokenMap.get(ok);
            if (!existing || match.pattern > existing.pattern) {
                tokenMap.set(ok, {
                    pattern: match.pattern,
                    sl, sc, el, ec,
                    startIndex: node.startIndex,
                    endIndex: node.endIndex,
                    type: rawMapping.type,
                    modifiers: rawMapping.modifiers,
                    captureName: name,
                });
            }
        }
    }

    // Share the global sets and scopes.
    return {
        tokenMap,
        nullMap,
        finalMappingIndex: global.finalMappingIndex,
        referenceNodes: global.referenceNodes,
        definitionNodes: global.definitionNodes,
        scopeNodes: [],
        definitions: [],
    };
}

/** Resolve references, split overlaps, sort and slice into final entries. */
function finishEntries(
    code: string,
    data: CombinedData,
    scopes: ScopeEntry[],
    cachedRawLines?: string[],
    cachedLineLens?: number[],
): TokenEntry[] {
    const rawLines = cachedRawLines ?? code.split('\n');
    const lineLens = cachedLineLens ?? rawLines.map(l => l.endsWith('\r') ? l.length - 1 : l.length);

    const tokenMap = data.tokenMap;

    // Move reference tokens into deferredMap, resolved later.
    const deferredMap = new Map<number, DeferredToken>();
    for (const [ok, tok] of tokenMap) {
        if (data.referenceNodes.has(byteKey(tok.startIndex, tok.endIndex))
            && !data.definitionNodes.has(byteKey(tok.startIndex, tok.endIndex))) {
            const mapping = CAPTURE_MAP[tok.captureName];
            if (!mapping) continue;
            tokenMap.delete(ok);
            deferredMap.set(ok, {
                ...tok,
                mapping,
                text: rawLines[tok.sl].slice(tok.sc, tok.ec),
            });
        }
    }

    // A reference with a definition reuses its highlight.
    for (const [ok, d] of deferredMap) {
        let finalMapping = d.mapping;
        let captureName = d.captureName;
        const def = findDefinition(d.text, d.startIndex, scopes);
        if (def) {
            // Inherit the definition's type but not its declaration modifier.
            // A reference is not a declaration.
            finalMapping = {
                type: def.mapping.type,
                modifiers: def.mapping.modifiers.filter(modifier => modifier !== 'declaration'),
            };
            captureName = def.captureName;
        }
        tokenMap.set(ok, {
            pattern: d.pattern,
            sl: d.sl, sc: d.sc, el: d.el, ec: d.ec,
            startIndex: d.startIndex,
            endIndex: d.endIndex,
            type: finalMapping.type,
            modifiers: finalMapping.modifiers,
            captureName,
        });
    }

    const mappedTokens = [...tokenMap.values()];
    const allTokens = splitOverlapping(mappedTokens);

    const keptNulls = filterNullTokens([...data.nullMap.values()], mappedTokens);

    const merged = [...allTokens, ...keptNulls];
    merged.sort((a, b) => (a.sl - b.sl) || (a.sc - b.sc) || (a.el - b.el) || (a.ec - b.ec));

    const entries: TokenEntry[] = [];
    for (const tok of merged) {
        pushSegments(entries, rawLines, lineLens, tok.sl, tok.sc, tok.el, tok.ec, tok.type, tok.modifiers, tok.captureName);
    }
    return entries;
}

/** Split one token into segments on one line. */
function pushSegments(
    entries: TokenEntry[],
    rawLines: string[],
    lineLens: number[],
    sl: number, sc: number, el: number, ec: number,
    type: string | null,
    modifiers: string[],
    captureName: string,
): void {
    const push = (line: number, col: number, end: number) => {
        if (end <= col) return;
        // A line index beyond the text is empty, e.g. a viewport past EOF.
        const text = (line < rawLines.length ? rawLines[line] : '').slice(col, end);
        if (text.length === 0) return;
        entries.push({
            line,
            col,
            text,
            captureName,
            type,
            modifiers,
        });
    };
    if (sl === el) {
        push(sl, sc, ec);
        return;
    }
    push(sl, sc, lineLens[sl]);
    for (let line = sl + 1; line < el; line++) {
        push(line, 0, lineLens[line]);
    }
    push(el, 0, ec);
}

/**
 * Returns final entries, sorted and split into segments on one line.
 */
export function collectTokenEntries(
    code: string,
    combinedMatches: QueryMatch[],
): TokenEntry[] {
    const data = singlePassCollect(combinedMatches);
    const scopes = buildScopes(data);
    return finishEntries(code, data, scopes);
}
