import * as fs from 'fs';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { SCOPED_MODEL_CACHE_MAX_ENTRIES } from '../../limits';
import { byteKey } from '../../shared/keys';
import { LazyQuery } from '../../shared/lazyQuery';
import { LruCache } from '../../shared/lruCache';
import type { SourcePosition, SourceUri, TextSnapshot } from '../documents';
import {
    addScopeDefinition, createScopeEntries, GLOBAL_SCOPE, hasErrorAncestor, scopeContext,
    type ScopeEntry, type SourceSpan,
} from './scopes';

export type BindingKind = 'parameter' | 'variable' | 'function';
export type BindingRole = 'parameter' | 'local' | 'assignment' | 'loop';

export interface BindingFact extends SourceSpan {
    name: string;
    kind: BindingKind;
    role: BindingRole;
    /** Enclosing syntactic scope, not the target of an assignment to an outer/global variable. */
    scope: number;
    position: SourcePosition;
    headerText: string | null;
}

export interface ReadCall {
    end: number;
    path: string;
}

export interface BindingFacts {
    readonly bindings: readonly BindingFact[];
    readonly scopes: readonly ScopeEntry<BindingFact>[];
    readonly scopeByStart: ReadonlyMap<number, ScopeEntry<BindingFact>>;
    readonly readCalls: readonly ReadCall[];
}

const CAPTURE_KIND: Record<string, BindingKind> = {
    'completion.parameter': 'parameter',
    'completion.var': 'variable',
    'completion.function': 'function',
};
const KIND_PRIORITY: Record<BindingKind, number> = { variable: 1, parameter: 2, function: 3 };

function functionHeaderText(node: SyntaxNode): string | null {
    const parent = node.parent;
    if (parent?.type !== 'assignment_statement') return null;
    const right = parent.childForFieldName('right');
    if (!right || (right.type !== 'function' && right.type !== 'atomic_function')) return null;
    const parameters = right.childForFieldName('parameters');
    return parameters ? right.text.slice(0, parameters.endIndex - right.startIndex).replace(/\s+/g, ' ').trimEnd() : null;
}

export class BindingAnalysis {
    private readonly query: LazyQuery;
    private readonly documents = new LruCache<string, { version: number; tree: Tree; facts: BindingFacts }>({
        maxEntries: SCOPED_MODEL_CACHE_MAX_ENTRIES,
    });

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf8'));
    }

    getDocument(document: TextSnapshot, tree: Tree): BindingFacts {
        const key = document.uri.toString();
        const cached = this.documents.peek(key);
        if (cached?.version === document.version && cached.tree === tree) {
            this.documents.touch(key, cached);
            return cached.facts;
        }
        const facts = this.collect(tree.rootNode);
        this.documents.set(key, { version: document.version, tree, facts });
        return facts;
    }

    collect(root: SyntaxNode): BindingFacts {
        const scopeRanges: SourceSpan[] = [];
        const candidates = new Map<number, { node: SyntaxNode; kind: BindingKind }>();
        const readCalls: ReadCall[] = [];
        for (const match of this.query.get().matches(root)) {
            let readNode: SyntaxNode | null = null;
            let readFunction = '';
            let readPath = '';
            for (const { name, node } of match.captures) {
                if (hasErrorAncestor(node)) continue;
                if (name === 'completion.scope') {
                    scopeRanges.push({ start: node.startIndex, end: node.endIndex });
                } else if (name === 'completion.read-call') {
                    readNode = node;
                } else if (name === 'completion.read-fn') {
                    readFunction = node.text;
                } else if (name === 'completion.read-path') {
                    readPath = node.text;
                } else {
                    const kind = CAPTURE_KIND[name];
                    if (!kind) continue;
                    const key = byteKey(node.startIndex, node.endIndex);
                    const previous = candidates.get(key);
                    if (!previous || KIND_PRIORITY[kind] > KIND_PRIORITY[previous.kind]) candidates.set(key, { node, kind });
                }
            }
            if (readNode && readFunction === 'Read' && readPath) readCalls.push({ end: readNode.endIndex, path: readPath });
        }

        const scopes = createScopeEntries<BindingFact>(scopeRanges);
        const scopeByStart = new Map(scopes.slice(1).map(scope => [scope.start, scope]));
        const bindings: BindingFact[] = [];
        for (const { node, kind } of candidates.values()) {
            const scope = scopeContext(node, scopeByStart).scope?.startIndex ?? GLOBAL_SCOPE;
            const role: BindingRole = kind === 'parameter' ? 'parameter'
                : node.parent?.type === 'locals' ? 'local'
                    : node.parent?.type === 'for_statement' ? 'loop' : 'assignment';
            const fact: BindingFact = {
                name: node.text, start: node.startIndex, end: node.endIndex, kind, role, scope,
                position: { line: node.startPosition.row, character: node.startPosition.column },
                headerText: functionHeaderText(node),
            };
            bindings.push(fact);
            addScopeDefinition(scopeByStart.get(scope) ?? scopes[0], fact.name, fact);
        }
        for (const scope of scopes) {
            for (const definitions of scope.definitions.values()) definitions.sort((a, b) => a.end - b.end);
        }
        return { bindings, scopes, scopeByStart, readCalls };
    }

    onDocumentClosed(uri: SourceUri): void {
        this.documents.delete(uri.toString());
    }

    dispose(): void {
        this.documents.clear();
        this.query.dispose();
    }
}
