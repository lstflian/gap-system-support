import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { SourcePosition, SourceRange } from '../documents';
import { GLOBAL_SCOPE, hasErrorAncestor, namedNodes, scopeContext, type SourceSpan } from './scopes';

export type DefinitionSymbolKind = 'parameter' | 'variable' | 'function' | 'global-function'
    | 'operation' | 'method' | 'attribute' | 'global';

export interface SymbolDefinitionFact extends SourceSpan {
    name: string;
    position: SourcePosition;
    scope: number;
    kind: DefinitionSymbolKind;
    role: 'member' | 'declaration' | 'implementation';
}

type DeclaredSymbol = SymbolDefinitionFact & { role: 'declaration' | 'implementation' };
type MemberSymbol = SymbolDefinitionFact & { role: 'member' };

const DECLARATION_CALLS = new Map<string, DefinitionSymbolKind>([
    ['DeclareGlobalFunction', 'global-function'],
    ['DeclareGlobalName', 'global'],
    ['DeclareGlobalVariable', 'global'],
    ['DeclareOperation', 'operation'],
    ['DeclareAttribute', 'attribute'],
    ['DeclareProperty', 'attribute'],
    ['DeclareCategory', 'attribute'],
    ['DeclareFilter', 'attribute'],
    ['DeclareRepresentation', 'attribute'],
    ['DeclareSynonym', 'global'],
    ['DeclareSynonymAttr', 'attribute'],
    ['DeclareTagBasedOperation', 'operation'],
    ['DeclareConstructor', 'global'],
    ['DeclareDataType', 'global'],
    ['DeclareInfoClass', 'global'],
    ['DeclareHasAndSet', 'global'],
    ['DeclareObsoleteSynonym', 'global'],
    ['DeclareObsoleteSynonymAttr', 'attribute'],
    ['DeclareOperationWithCache', 'operation'],
    ['DeclareAttributeWithCustomGetter', 'attribute'],
    ['DeclareAttributeThatReturnsDigraph', 'attribute'],
]);

const IMPLEMENTATION_CALLS = new Map<string, DefinitionSymbolKind>([
    ['InstallGlobalFunction', 'global-function'],
    ['InstallMethod', 'method'],
    ['InstallOtherMethod', 'method'],
    ['InstallEarlyMethod', 'method'],
    ['InstallImmediateMethod', 'method'],
    ['InstallTrueMethod', 'method'],
    ['InstallTagBasedMethod', 'method'],
    ['InstallValue', 'global'],
    ['BindGlobal', 'global'],
    ['BindConstant', 'global'],
    ['BindThreadLocal', 'global'],
    ['BindThreadLocalConstructor', 'global'],
]);

const STRING_NAME_CALLS = new Set([
    ...DECLARATION_CALLS.keys(),
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

function identifierNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    let node = root.descendantForIndex(clamped);
    if (!node || node.type !== 'identifier') {
        const previous = root.descendantForIndex(Math.max(0, clamped - 1));
        if (previous?.type === 'identifier') node = previous;
    }
    return node?.type === 'identifier' ? node : null;
}

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

export function symbolNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const identifier = identifierNodeAt(root, offset);
    if (identifier) return identifier;
    return declarationStringNodeAt(root, offset);
}

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

function declaredSymbol(node: SyntaxNode): DeclaredSymbol | null {
    if (node.type !== 'call') return null;
    const functionNode = node.childForFieldName('function');
    const firstArgument = node.childForFieldName('arguments')?.namedChildren[0];
    if (functionNode?.type !== 'identifier' || !firstArgument) return null;
    const functionName = functionNode.text;
    const declaration = isDeclarationCall(functionName);
    const kind = DECLARATION_CALLS.get(functionName) ?? IMPLEMENTATION_CALLS.get(functionName)
        ?? (declaration || isImplementationCall(functionName) ? 'global' : undefined);
    if (!kind) return null;

    let nameNode: SyntaxNode | null = null;
    if (declaration && firstArgument.type === 'string') {
        nameNode = firstArgument.namedChildren.find(child => child?.type === 'string_content') ?? null;
    } else if (!declaration) {
        if (STRING_NAME_CALLS.has(functionName) && firstArgument.type === 'string') {
            nameNode = firstArgument.namedChildren.find(child => child?.type === 'string_content') ?? null;
        } else {
            nameNode = firstArgument.type === 'identifier' ? firstArgument
                : firstArgument.type === 'record_selector' || firstArgument.type === 'component_selector'
                    ? firstArgument.childForFieldName('selector') : null;
        }
    } else if (firstArgument.type === 'identifier') {
        nameNode = firstArgument;
    }
    if (!nameNode || hasErrorAncestor(nameNode)) return null;
    return {
        name: firstArgument.type === 'record_selector' || firstArgument.type === 'component_selector'
            ? firstArgument.text : nameNode.text,
        start: nameNode.startIndex,
        end: nameNode.endIndex,
        position: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
        scope: GLOBAL_SCOPE,
        kind,
        role: declaration ? 'declaration' : 'implementation',
    };
}

export function collectSymbolDefinitions(root: SyntaxNode): {
    members: MemberSymbol[];
    declarations: DeclaredSymbol[];
} {
    const members: MemberSymbol[] = [];
    const declarations: DeclaredSymbol[] = [];
    for (const node of namedNodes(root)) {
        let nameNode: SyntaxNode | null = null;
        let name: string | null = null;
        let rangeNode: SyntaxNode | null = null;
        if (node.type === 'record_entry') {
            nameNode = node.childForFieldName('left');
            if (nameNode?.type === 'identifier') name = recordEntryLookupName(node) ?? nameNode.text;
        } else if (node.type === 'assignment_statement') {
            const left = node.childForFieldName('left');
            if (left?.type === 'record_selector' || left?.type === 'component_selector') {
                nameNode = left.childForFieldName('selector');
                if (nameNode?.type === 'identifier') { name = left.text; rangeNode = left; }
            }
        }
        if (nameNode && name !== null) {
            const context = scopeContext(nameNode);
            if (!context.hasError) {
                members.push({
                    name,
                    start: (rangeNode ?? nameNode).startIndex,
                    end: (rangeNode ?? nameNode).endIndex,
                    position: { line: nameNode.startPosition.row, character: nameNode.startPosition.column },
                    scope: context.scope?.startIndex ?? GLOBAL_SCOPE,
                    kind: 'variable',
                    role: 'member',
                });
            }
        }
        const declaration = declaredSymbol(node);
        if (declaration) declarations.push(declaration);
    }
    return { members, declarations };
}

/** Source occurrences only; callers decide whether each occurrence resolves to a requested symbol. */
export function collectSymbolOccurrences(root: SyntaxNode): Map<string, SourceRange[]> {
    const symbols = new Map<string, SourceRange[]>();
    for (const node of namedNodes(root)) {
        if (node.type !== 'identifier' && node.type !== 'string_content') continue;
        if (symbolNameNodeAt(root, node.startIndex)?.id !== node.id) continue;
        const name = symbolLookupName(node);
        const occurrence: SourceRange = {
            start: { line: node.startPosition.row, character: node.startPosition.column },
            end: { line: node.endPosition.row, character: node.endPosition.column },
        };
        const entries = symbols.get(name);
        if (entries) entries.push(occurrence);
        else symbols.set(name, [occurrence]);
    }
    return symbols;
}
