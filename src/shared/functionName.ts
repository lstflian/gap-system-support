/** Shared gating for function name identifiers. */

import type { SyntaxNode } from 'web-tree-sitter';

/**
 * Return the identifier node when the cursor is on a function name.
 * Positions on a call callee or a function definition LHS qualify.
 * All other positions, such as variables, parameters, or keywords, return null.
 */
export function functionNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));

    // A cursor right after the name falls into the parent node.
    // Fall back to the node at the previous character in that case.
    let node = root.descendantForIndex(clamped);
    if (!node || node.type !== 'identifier') {
        const prev = root.descendantForIndex(Math.max(0, clamped - 1));
        if (prev && prev.type === 'identifier') {
            node = prev;
        }
    }
    if (!node || node.type !== 'identifier') return null;

    const parent = node.parent;
    if (!parent) return null;

    if (parent.type === 'assignment_statement') {
        // Match the left child against the node by id.
        const left = parent.childForFieldName('left');
        if (left && left.id === node.id) {
            const right = parent.childForFieldName('right');
            if (right && (right.type === 'function'
                || right.type === 'atomic_function'
                || right.type === 'lambda')) {
                return node;
            }
        }
    }

    if (parent.type === 'call') {
        const callee = parent.childForFieldName('function');
        // Every call callee names a function.
        if (callee && callee.id === node.id) {
            return node;
        }
    }

    return null;
}
