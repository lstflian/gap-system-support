/**
 * Shared syntax tree utilities.
 */

import type { SyntaxNode } from 'web-tree-sitter';

/** Check whether the node or any ancestor up to source_file is an ERROR node. */
export function hasErrorAncestor(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node;
    while (current && current.type !== 'source_file') {
        if (current.type === 'ERROR') return true;
        current = current.parent;
    }
    return false;
}

/** Return whether the node is defined outside an enclosing function. */
export function isTopLevel(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node.parent;
    while (current && current.type !== 'source_file') {
        if (current.type === 'function' || current.type === 'lambda' || current.type === 'atomic_function') {
            return false;
        }
        current = current.parent;
    }
    return true;
}
