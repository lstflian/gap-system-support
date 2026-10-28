/** Shared gating for function and GAP symbol names. */

import type { Node as SyntaxNode } from 'web-tree-sitter';

const DECLARATION_CALLS = new Set([
    'DeclareGlobalFunction',
    'DeclareGlobalName',
    'DeclareGlobalVariable',
    'DeclareOperation',
    'DeclareAttribute',
    'DeclareProperty',
    'DeclareCategory',
    'DeclareFilter',
    'DeclareRepresentation',
    'DeclareSynonym',
    'DeclareSynonymAttr',
    'DeclareTagBasedOperation',
    'DeclareConstructor',
    'DeclareDataType',
    'DeclareInfoClass',
    'DeclareHasAndSet',
    'DeclareObsoleteSynonym',
    'DeclareObsoleteSynonymAttr',
    'DeclareOperationWithCache',
    'DeclareAttributeWithCustomGetter',
    'DeclareAttributeThatReturnsDigraph',
]);

const IMPLEMENTATION_CALLS = new Set([
    'InstallGlobalFunction',
    'InstallMethod',
    'InstallOtherMethod',
    'InstallEarlyMethod',
    'InstallImmediateMethod',
    'InstallTrueMethod',
    'InstallTagBasedMethod',
    'InstallValue',
    'BindGlobal',
    'BindConstant',
    'BindThreadLocal',
    'BindThreadLocalConstructor',
]);

const STRING_NAME_CALLS = new Set([
    ...DECLARATION_CALLS,
    'BindGlobal',
    'BindConstant',
    'BindThreadLocalConstructor',
]);

function isDeclarationCall(name: string): boolean {
    return DECLARATION_CALLS.has(name) ||
        /^(?:DeclareOperation|DeclareAttribute|DeclareProperty|DeclareCategory|DeclareRepresentation|DeclareConstructor)Kernel$/.test(name) ||
        /^(?:DeclareAttribute|DeclareProperty)SuppCT$/.test(name);
}

function isImplementationCall(name: string): boolean {
    return IMPLEMENTATION_CALLS.has(name) ||
        /^Install(?:Other)?Method(?:With.*|ForCompilerForCAP|ThatReturnsDigraph)?$/.test(name);
}

/**
 * Return the name node when the cursor is on a function or GAP symbol name.
 * Positions on a call callee, function definition LHS, or declaration/
 * installation name qualify.
 * All other positions, such as variables, parameters, or keywords, return null.
 */
export function functionNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const node = identifierNodeAt(root, offset);
    if (!node) return null;

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

    if (parent.type === 'argument_list') {
        const call = parent.parent;
        const functionNode = call?.type === 'call' ? call.childForFieldName('function') : null;
        const firstArgument = parent.namedChildren[0];
        if (call?.type === 'call' &&
            functionNode?.type === 'identifier' &&
            firstArgument?.id === node.id &&
            isImplementationCall(functionNode.text)) {
            return node;
        }
    }

    return null;
}

/** Return the identifier at the cursor, including a cursor at the word end. */
function identifierNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    let node = root.descendantForIndex(clamped);
    if (!node || node.type !== 'identifier') {
        const previous = root.descendantForIndex(Math.max(0, clamped - 1));
        if (previous?.type === 'identifier') node = previous;
    }
    return node?.type === 'identifier' ? node : null;
}

/** Return a declaration string name under the cursor. */
function declarationStringNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    let node = root.descendantForIndex(Math.max(0, Math.min(offset, root.endIndex - 1)));
    if (!node || node.type !== 'string_content') {
        const previous = root.descendantForIndex(Math.max(0, Math.min(offset - 1, root.endIndex - 1)));
        if (previous?.type === 'string_content') node = previous;
    }
    if (!node || node.type !== 'string_content') return null;

    const stringNode = node.parent;
    const argumentsNode = stringNode?.parent;
    const call = argumentsNode?.parent;
    if (stringNode?.type !== 'string' ||
        argumentsNode?.type !== 'argument_list' ||
        call?.type !== 'call') {
        return null;
    }
    const functionNode = call.childForFieldName('function');
    const firstArgument = argumentsNode.namedChildren[0];
    if (functionNode?.type !== 'identifier' ||
        firstArgument?.id !== stringNode.id ||
        !isDeclarationCall(functionNode.text) && !STRING_NAME_CALLS.has(functionNode.text)) {
        return null;
    }
    return node;
}

/** Return any resolvable GAP symbol name under the cursor. */
export function symbolNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const identifier = identifierNodeAt(root, offset);
    if (identifier) return identifier;
    return declarationStringNodeAt(root, offset);
}

/** Build the qualified name of a field declared inside an assigned rec(...). */
export function recordEntryLookupName(recordEntry: SyntaxNode): string | null {
    let current: SyntaxNode | null = recordEntry;
    const fields: string[] = [];
    while (current && current.type !== 'source_file') {
        if (current.type === 'record_entry') {
            const left = current.childForFieldName('left');
            if (left?.type !== 'identifier') return null;
            fields.unshift(left.text);
        }
        if (current.type === 'assignment_statement') {
            const left = current.childForFieldName('left');
            if (!left || (left.type !== 'identifier' &&
                left.type !== 'record_selector' &&
                left.type !== 'component_selector')) {
                return null;
            }
            return [left.text, ...fields].join('.');
        }
        current = current.parent;
    }
    return null;
}

/** Return the lookup key for a symbol, preserving record/component paths. */
export function symbolLookupName(node: SyntaxNode): string {
    const parent = node.parent;
    if (parent?.type === 'record_entry' &&
        parent.childForFieldName('left')?.id === node.id) {
        return recordEntryLookupName(parent) ?? node.text;
    }
    if (parent &&
        (parent.type === 'record_selector' || parent.type === 'component_selector') &&
        parent.childForFieldName('selector')?.id === node.id) {
        return parent.text;
    }
    return node.text;
}
