import { SCOPED_CONTENT_LIMIT } from '../../limits';
import type { SourceDocument, SourcePosition, SourceUri } from '../documents';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import { BindingAnalysis, type BindingKind, type ReadCall } from './bindings';
import { GLOBAL_SCOPE, lastDefinitionBefore, visibleScopeStarts } from './scopes';

export type ScopedKind = BindingKind;
export type { ReadCall } from './bindings';

export interface ScopedItem {
    name: string;
    kind: ScopedKind;
    isGlobal: boolean;
}

export class GAPScopedCompletions {
    private readonly analysis: BindingAnalysis;
    private readonly ownsAnalysis: boolean;

    constructor(completionPath: string, analysis?: BindingAnalysis) {
        this.analysis = analysis ?? new BindingAnalysis(completionPath);
        this.ownsAnalysis = analysis === undefined;
    }

    onDocumentClosed(uri: SourceUri): void {
        this.analysis.onDocumentClosed(uri);
    }

    dispose(): void {
        if (this.ownsAnalysis) this.analysis.dispose();
    }

    getItems(document: SourceDocument, position: SourcePosition): ScopedItem[] {
        if (!isParserReady()) return [];
        const code = document.getText();
        if (code.length > SCOPED_CONTENT_LIMIT) return [];

        const tree = getDocumentTree(document, code);
        const facts = this.analysis.getDocument(document, tree);
        const offset = Math.max(0, Math.min(document.offsetAt(position), tree.rootNode.endIndex));
        const chain = visibleScopeStarts(tree.rootNode, offset, facts.scopeByStart);
        const result: ScopedItem[] = [];
        const seen = new Set<string>();
        for (const key of chain) {
            const scope = key === GLOBAL_SCOPE ? facts.scopes[0] : facts.scopeByStart.get(key)!;
            for (const [name, definitions] of scope.definitions) {
                if (seen.has(name)) continue;
                const definition = lastDefinitionBefore(definitions, offset);
                if (definition) {
                    result.push({ name, kind: definition.kind, isGlobal: key === GLOBAL_SCOPE });
                    seen.add(name);
                }
            }
        }
        return result;
    }

    getReadCalls(document: SourceDocument, position: SourcePosition): ReadCall[] {
        if (!isParserReady()) return [];
        const code = document.getText();
        if (code.length > SCOPED_CONTENT_LIMIT) return [];
        const tree = getDocumentTree(document, code);
        const facts = this.analysis.getDocument(document, tree);
        const offset = document.offsetAt(position);
        return facts.readCalls.filter(call => call.end <= offset);
    }
}
