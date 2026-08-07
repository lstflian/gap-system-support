/**
 * Token structures and the overlap split helpers.
 */

import type { SyntaxNode } from 'web-tree-sitter';
import type { TokenMapping } from './captureMap';

/** One final token entry, already split into segments on one line. */
export interface TokenEntry {
    line: number;
    col: number;
    text: string;
    captureName: string;
    type: string | null;
    modifiers: string[];
}

/** Internal token before line splitting, no text. */
export interface InternalToken {
    pattern: number;
    sl: number;
    sc: number;
    el: number;
    ec: number;
    startIndex: number;
    endIndex: number;
    type: string | null;
    modifiers: string[];
    captureName: string;
}

/** A reference token resolved against the scope table. */
export type DeferredToken = InternalToken & { mapping: TokenMapping; text: string };

/**
 * Data collected in one pass over the combined query matches.
 * Locals captures feed the scope table, highlight captures feed the tokens.
 */
export interface CombinedData {
    tokenMap: Map<number, InternalToken>;
    nullMap: Map<number, InternalToken>;
    finalMappingIndex: Map<number, { mapping: TokenMapping; captureName: string }>;
    referenceNodes: Set<number>;
    definitionNodes: Set<number>;
    scopeNodes: SyntaxNode[];
    definitions: SyntaxNode[];
}

/** Whether the outer range contains the inner range. */
function contains(outer: InternalToken, inner: InternalToken): boolean {
    const startOk = outer.sl < inner.sl || (outer.sl === inner.sl && outer.sc <= inner.sc);
    const endOk = outer.el > inner.el || (outer.el === inner.el && outer.ec >= inner.ec);
    return startOk && endOk;
}

/** Compare start pairs, negative when a is before b. */
function cmpStart(
    a: { sl: number; sc: number },
    b: { sl: number; sc: number },
): number {
    return (a.sl - b.sl) || (a.sc - b.sc);
}

/** Compare end pairs, negative when a is before b. */
function cmpEnd(
    a: { el: number; ec: number },
    b: { el: number; ec: number },
): number {
    return (a.el - b.el) || (a.ec - b.ec);
}

/** A node with a token and child nodes. */
interface TreeNode {
    tok: InternalToken;
    children: TreeNode[];
}

/**
 * Split wide tokens that contain narrower tokens.
 * Returns a flat array.
 */
export function splitOverlapping(allTokens: InternalToken[]): InternalToken[] {
    if (allTokens.length < 2) return [...allTokens];

    // Sort by start ascending, then by end descending, a parent comes first.
    const sorted = [...allTokens].sort((a, b) =>
        cmpStart(a, b) || cmpEnd(b, a));

    // Build the tree with a stack.
    const roots: TreeNode[] = [];
    const stack: TreeNode[] = [];
    for (const tok of sorted) {
        while (stack.length > 0 && !contains(stack[stack.length - 1].tok, tok)) {
            stack.pop();
        }
        const node: TreeNode = { tok, children: [] };
        if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
        } else {
            roots.push(node);
        }
        stack.push(node);
    }

    const result: InternalToken[] = [];
    const emit = (node: TreeNode): void => {
        const tok = node.tok;
        if (node.children.length === 0) {
            result.push(tok);
            return;
        }
        let cl = tok.sl;
        let cc = tok.sc;
        for (const child of node.children) {
            const c = child.tok;
            if (cmpEnd(c, { el: cl, ec: cc }) <= 0) continue;
            if (cmpStart({ sl: cl, sc: cc }, c) < 0) {
                result.push({ ...tok, sl: cl, sc: cc, el: c.sl, ec: c.sc });
            }
            cl = c.el;
            cc = c.ec;
            emit(child);
        }
        if (cmpStart({ sl: cl, sc: cc }, { sl: tok.el, sc: tok.ec }) < 0) {
            result.push({ ...tok, sl: cl, sc: cc, el: tok.el, ec: tok.ec });
        }
    };
    for (const root of roots) emit(root);
    return result;
}

/**
 * Filter null entries that stay visible.
 */
export function filterNullTokens(
    nullTokens: InternalToken[],
    mappedTokens: InternalToken[],
): InternalToken[] {
    if (nullTokens.length === 0) return [];
    if (mappedTokens.length === 0) return [...nullTokens];

    const sorted = [...mappedTokens].sort((a, b) =>
        cmpStart(a, b) || cmpEnd(b, a));
    const n = sorted.length;

    // Prefix max end.
    const prefEl = new Array<number>(n);
    const prefEc = new Array<number>(n);
    let mel = -1;
    let mec = -1;
    for (let i = 0; i < n; i++) {
        const m = sorted[i];
        if (m.el > mel || (m.el === mel && m.ec > mec)) {
            mel = m.el;
            mec = m.ec;
        }
        prefEl[i] = mel;
        prefEc[i] = mec;
    }

    // Suffix min end.
    const suffEl = new Array<number>(n);
    const suffEc = new Array<number>(n);
    let nel = Number.MAX_SAFE_INTEGER;
    let nec = Number.MAX_SAFE_INTEGER;
    for (let i = n - 1; i >= 0; i--) {
        const m = sorted[i];
        if (m.el < nel || (m.el === nel && m.ec < nec)) {
            nel = m.el;
            nec = m.ec;
        }
        suffEl[i] = nel;
        suffEc[i] = nec;
    }

    const upperBoundStart = (sl: number, sc: number): number => {
        let lo = 0;
        let hi = n - 1;
        let ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const m = sorted[mid];
            if (m.sl < sl || (m.sl === sl && m.sc <= sc)) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return ans;
    };

    const lowerBoundStart = (sl: number, sc: number): number => {
        let lo = 0;
        let hi = n - 1;
        let ans = n;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const m = sorted[mid];
            if (m.sl < sl || (m.sl === sl && m.sc < sc)) {
                lo = mid + 1;
            } else {
                ans = mid;
                hi = mid - 1;
            }
        }
        return ans;
    };

    const kept: InternalToken[] = [];
    for (const nt of nullTokens) {
        // Drop null tokens contained by a mapped token.
        const i = upperBoundStart(nt.sl, nt.sc);
        if (i >= 0 && cmpEnd({ el: prefEl[i], ec: prefEc[i] }, nt) >= 0) continue;
        // Drop null tokens that contain a mapped token.
        const j = lowerBoundStart(nt.sl, nt.sc);
        if (j < n && cmpEnd({ el: suffEl[j], ec: suffEc[j] }, nt) <= 0) continue;
        kept.push(nt);
    }
    return kept;
}
