import type { Node as SyntaxNode } from 'web-tree-sitter';
import { byteKey } from '../../shared/keys';
import { addScopeDefinition, createScopeEntries, scopeContext, type ScopeEntry, type SourceSpan } from '../analysis/scopes';
import type { TokenMapping } from './captureMap';

export interface HighlightDefinition extends SourceSpan {
    mapping: TokenMapping;
    captureName: string;
}

export type HighlightScope = ScopeEntry<HighlightDefinition>;

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
export function buildHighlightScopes(data: ScopeInput): HighlightScope[] {
    const entries = createScopeEntries<HighlightDefinition>(
        data.scopeNodes.map(node => ({ start: node.startIndex, end: node.endIndex })),
    );
    const scopeByStart = new Map(entries.slice(1).map(scope => [scope.start, scope]));
    for (const node of data.definitions) {
        const context = scopeContext(node, scopeByStart);
        if (context.hasError) continue;
        const target = context.scope ? scopeByStart.get(context.scope.startIndex)! : entries[0];
        const finalInfo = data.finalMappingIndex.get(byteKey(node.startIndex, node.endIndex));
        if (!finalInfo) continue;
        addScopeDefinition(target, node.text, {
            start: node.startIndex, end: node.endIndex, mapping: finalInfo.mapping, captureName: finalInfo.captureName,
        });
    }

    return entries;
}
