import type { Node as SyntaxNode } from 'web-tree-sitter';

export const GLOBAL_SCOPE = -1;

export interface SourceSpan {
    start: number;
    end: number;
}

export interface ScopeEntry<T> extends SourceSpan {
    definitions: Map<string, T[]>;
}

const FUNCTION_SCOPES = new Set(['function', 'lambda', 'atomic_function']);

export function isFunctionScope(node: SyntaxNode): boolean {
    return FUNCTION_SCOPES.has(node.type);
}

export function* namedNodes(root: SyntaxNode): IterableIterator<SyntaxNode> {
    const pending = [root];
    while (pending.length) {
        const node = pending.pop()!;
        yield node;
        const children = node.namedChildren;
        for (let index = children.length - 1; index >= 0; index--) {
            const child = children[index];
            if (child) pending.push(child);
        }
    }
}

export function scopeContext(node: SyntaxNode, scopes?: { has(start: number): boolean }): {
    scope: SyntaxNode | null;
    hasError: boolean;
} {
    let scope: SyntaxNode | null = null;
    let hasError = false;
    for (let current: SyntaxNode | null = node; current && current.type !== 'source_file'; current = current.parent) {
        if (current.type === 'ERROR') hasError = true;
        if (!scope && (scopes ? scopes.has(current.startIndex) : isFunctionScope(current))) scope = current;
    }
    return { scope, hasError };
}

export function hasErrorAncestor(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current && current.type !== 'source_file') {
        if (current.type === 'ERROR') return true;
        current = current.parent;
    }
    return false;
}

export function createScopeEntries<T>(ranges: readonly SourceSpan[]): ScopeEntry<T>[] {
    return [
        { start: 0, end: Number.MAX_SAFE_INTEGER, definitions: new Map<string, T[]>() },
        ...[...ranges].sort((a, b) => (b.end - b.start) - (a.end - a.start))
            .map(({ start, end }) => ({ start, end, definitions: new Map<string, T[]>() })),
    ];
}

export function addScopeDefinition<T>(scope: ScopeEntry<T>, name: string, definition: T): void {
    const definitions = scope.definitions.get(name);
    if (definitions) definitions.push(definition);
    else scope.definitions.set(name, [definition]);
}

/** Inner scopes first; malformed ancestors discard unreliable inner scopes. */
export function visibleScopeStarts(root: SyntaxNode, offset: number, scopes: { has(start: number): boolean }): number[] {
    const clamped = Math.max(0, Math.min(offset, root.endIndex));
    const visible: number[] = [];
    let current: SyntaxNode | null = clamped >= root.endIndex ? root : root.descendantForIndex(clamped);
    while (current && current.type !== 'source_file') {
        if (current.type === 'ERROR') visible.length = 0;
        else if (scopes.has(current.startIndex)) visible.push(current.startIndex);
        current = current.parent;
    }
    visible.push(GLOBAL_SCOPE);
    return visible;
}

export function lastDefinitionBefore<T extends { end: number }>(definitions: readonly T[], offset: number): T | null {
    for (let index = definitions.length - 1; index >= 0; index--) {
        if (definitions[index].end < offset) return definitions[index];
    }
    return null;
}

/** Lookup policy for ordered definitions; this does not infer GAP variable bindings. */
export function findPrecedingDefinition<T extends SourceSpan>(
    name: string, offset: number, scopes: readonly ScopeEntry<T>[],
): T | null {
    for (let index = scopes.length - 1; index >= 0; index--) {
        const scope = scopes[index];
        if (offset < scope.start || offset >= scope.end) continue;
        const definitions = scope.definitions.get(name);
        const definition = definitions && lastDefinitionBefore(definitions, offset);
        if (definition) return definition;
    }
    return null;
}
