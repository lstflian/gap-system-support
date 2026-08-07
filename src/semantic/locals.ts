/**
 * Locals scope table: definitions, scopes and reference resolution.
 */

import type { SyntaxNode } from 'web-tree-sitter';
import { byteKey } from './keys';
import type { TokenMapping } from './captureMap';

interface Definition {
    start: number;          // UTF-16 code unit offset.
    end: number;            // UTF-16 code unit offset.
    mapping: TokenMapping;  // Final highlight of the definition node.
    captureName: string;    // Final capture name of the definition node.
}

export interface ScopeEntry {
    start: number;   // UTF-16 code unit offset.
    end: number;     // UTF-16 code unit offset.
    definitions: Map<string, Definition[]>;
}

export const CAPTURE_KIND: Record<string, 'parameter' | 'variable' | 'function' | 'field'> = {
    'local.definition.parameter': 'parameter',
    'local.definition.var': 'variable',
    'local.definition.function': 'function',
    'local.definition.field': 'field',
};

export interface ScopeInput {
    scopeNodes: SyntaxNode[];
    definitions: SyntaxNode[];
    finalMappingIndex: Map<number, { mapping: TokenMapping; captureName: string }>;
}

/**
 * Build the scope table, definitions attach to the innermost scope.
 * A global scope covers the whole file.
 */
export function buildScopes(data: ScopeInput): ScopeEntry[] {
    // The global scope, the initial scope.
    const entries: ScopeEntry[] = [{
        start: 0,
        end: Number.MAX_SAFE_INTEGER,
        definitions: new Map(),
    }];

    // Sort outer scopes first.
    data.scopeNodes.sort((a, b) => (b.endIndex - b.startIndex) - (a.endIndex - a.startIndex));
    // Index scopes by their start offset.
    const scopeByStart = new Map<number, ScopeEntry>();
    for (const node of data.scopeNodes) {
        const entry: ScopeEntry = {
            start: node.startIndex,
            end: node.endIndex,
            definitions: new Map(),
        };
        scopeByStart.set(node.startIndex, entry);
        entries.push(entry);
    }

    // One parent chain climb finds the scope and detects ERROR ancestors.
    // The ERROR check covers the full chain above the found scope.
    for (const node of data.definitions) {
        let target: ScopeEntry = entries[0];
        let error = false;
        let foundScope = false;
        let current: SyntaxNode | null = node;
        while (current && current.type !== 'source_file') {
            if (current.type === 'ERROR') error = true;
            if (!foundScope) {
                const entry = scopeByStart.get(current.startIndex);
                if (entry) {
                    target = entry;
                    foundScope = true;
                }
            }
            current = current.parent;
        }
        if (error) continue;

        const finalInfo = data.finalMappingIndex.get(byteKey(node.startIndex, node.endIndex));
        if (!finalInfo) continue;

        const name = node.text;
        const list = target.definitions.get(name) ?? [];
        list.push({ start: node.startIndex, end: node.endIndex, mapping: finalInfo.mapping, captureName: finalInfo.captureName });
        target.definitions.set(name, list);
    }

    return entries;
}

/**
 * Find the nearest definition of name at offset idx.
 * Iterates from inner scopes to outer, only definitions ending before idx count.
 */
export function findDefinition(name: string, idx: number, entries: ScopeEntry[]): Definition | null {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        // Scope end is exclusive, a reference at the boundary lies outside.
        if (idx < entry.start || idx >= entry.end) continue;
        const defs = entry.definitions.get(name);
        if (!defs) continue;
        // The latest definition ending before the reference wins.
        for (let j = defs.length - 1; j >= 0; j--) {
            if (defs[j].end <= idx) return defs[j];
        }
    }
    return null;
}

/** Check whether the node or any ancestor up to source_file is an ERROR node. */
export function hasErrorAncestor(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current && current.type !== 'source_file') {
        if (current.type === 'ERROR') return true;
        current = current.parent;
    }
    return false;
}
