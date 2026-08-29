/**
 * Scoped completion: variables, parameters and functions visible at the cursor.
 * Uses the completion.scm query over the whole tree, cached per document version.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import type { QueryMatch, SyntaxNode, Tree } from 'web-tree-sitter';
import { byteKey } from '../shared/keys';
import { hasErrorAncestor } from '../shared/treeUtils';
import { LruCache } from '../shared/lruCache';
import { LazyQuery } from '../shared/lazyQuery';
import { SCOPED_CONTENT_LIMIT, SCOPED_MODEL_CACHE_MAX_ENTRIES } from '../limits';

export type ScopedKind = 'parameter' | 'variable' | 'function';

export interface ScopedItem {
    name: string;
    kind: ScopedKind;
    /** True when the definition lives in the global scope. */
    isGlobal: boolean;
}

export interface ReadCall {
    end: number;
    path: string;
}

/** One definition node and its resolved kind. */
interface DefNode {
    node: SyntaxNode;
    kind: ScopedKind;
}

interface Definition {
    name: string;
    end: number;
    kind: ScopedKind;
}

interface ScopeModel {
    start: number;
    end: number;
    /** Definitions by name, each list sorted by end ascending. */
    definitions: Map<string, Definition[]>;
    isGlobal: boolean;
}

interface DocumentModel {
    scopes: ScopeModel[];
    scopeByStart: Map<number, ScopeModel>;
    readCalls: ReadCall[];
}

const CAPTURE_KIND: Record<string, ScopedKind> = {
    'completion.parameter': 'parameter',
    'completion.var': 'variable',
    'completion.function': 'function',
};

/** More specific kinds win when one node matches several captures. */
const KIND_PRIORITY: Record<ScopedKind, number> = {
    variable: 1,
    parameter: 2,
    function: 3,
};

export class GapScopedCompletions {

    private readonly query: LazyQuery;
    // Model cache, keyed by uri and invalidated by (version, tree) identity.
    private modelCache = new LruCache<string, { version: number; tree: Tree; model: DocumentModel }>({
        maxEntries: SCOPED_MODEL_CACHE_MAX_ENTRIES,
    });

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf-8'));
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.modelCache.delete(uri.toString());
    }

    /** Run the query once per document version, cache the built model. */
    private getModel(document: vscode.TextDocument, tree: Tree): DocumentModel {
        const key = document.uri.toString();
        const cached = this.modelCache.peek(key);
        if (cached && cached.version === document.version && cached.tree === tree) {
            this.modelCache.touch(key, cached);
            return cached.model;
        }
        const matches = this.query.get().matches(tree.rootNode);
        const model = this.buildModel(matches);
        this.modelCache.set(key, { version: document.version, tree, model });
        return model;
    }

    /** Collect scopes and definitions from the query matches. */
    private buildModel(matches: QueryMatch[]): DocumentModel {
        const scopeNodes: SyntaxNode[] = [];
        const defs = new Map<number, DefNode>();
        const readCalls: ReadCall[] = [];

        for (const match of matches) {
            let readCall: ReadCall | null = null;
            let readFn = '';
            for (const capture of match.captures) {
                const node = capture.node;
                const name = capture.name;

                if (name === 'completion.scope') {
                    if (hasErrorAncestor(node)) continue;
                    scopeNodes.push(node);
                    continue;
                }

                if (name === 'completion.read-call') {
                    if (hasErrorAncestor(node)) continue;
                    readCall = { end: node.endIndex, path: '' };
                    continue;
                }
                if (name === 'completion.read-fn') {
                    if (!hasErrorAncestor(node)) readFn = node.text;
                    continue;
                }
                if (name === 'completion.read-path') {
                    if (readCall && !hasErrorAncestor(node)) {
                        readCall.path = node.text;
                    }
                    continue;
                }

                const kind = CAPTURE_KIND[name];
                if (!kind) continue;
                // Definitions inside ERROR subtrees are unreliable.
                if (hasErrorAncestor(node)) continue;

                const bkey = byteKey(node.startIndex, node.endIndex);
                const existing = defs.get(bkey);
                if (!existing || KIND_PRIORITY[kind] > KIND_PRIORITY[existing.kind]) {
                    defs.set(bkey, { node, kind });
                }
            }
            if (readCall && readFn === 'Read' && readCall.path) {
                readCalls.push(readCall);
            }
        }

        // The global scope, the fallback for definitions outside any function.
        const globalScope: ScopeModel = {
            start: 0,
            end: Number.MAX_SAFE_INTEGER,
            definitions: new Map(),
            isGlobal: true,
        };
        const scopes: ScopeModel[] = [globalScope];
        const scopeByStart = new Map<number, ScopeModel>();

        // Index scopes by their start offset.
        for (const node of scopeNodes) {
            const entry: ScopeModel = {
                start: node.startIndex,
                end: node.endIndex,
                definitions: new Map(),
                isGlobal: false,
            };
            scopeByStart.set(node.startIndex, entry);
            scopes.push(entry);
        }

        // Attach every definition to its innermost scope.
        for (const { node, kind } of defs.values()) {
            let target: ScopeModel = globalScope;
            let current: SyntaxNode | null = node.parent;
            while (current && current.type !== 'source_file') {
                const entry = scopeByStart.get(current.startIndex);
                if (entry) {
                    target = entry;
                    break;
                }
                current = current.parent;
            }

            const name = node.text;
            const list = target.definitions.get(name) ?? [];
            list.push({
                name,
                end: node.endIndex,
                kind,
            });
            target.definitions.set(name, list);
        }

        // Sort each definition list by end ascending, the latest wins.
        for (const scope of scopes) {
            for (const list of scope.definitions.values()) {
                list.sort((a, b) => a.end - b.end);
            }
        }

        return { scopes, scopeByStart, readCalls };
    }

    /** Return the items visible at the position, inner scopes first. */
    getItems(document: vscode.TextDocument, position: vscode.Position): ScopedItem[] {
        if (!isParserReady()) return [];

        const code = document.getText();
        if (code.length > SCOPED_CONTENT_LIMIT) return [];

        const tree = getDocumentTree(document, code);
        const model = this.getModel(document, tree);

        const offset = document.offsetAt(position);
        const clamped = Math.max(0, Math.min(offset, tree.rootNode.endIndex));

        // Walk the ancestors from the cursor node, collecting enclosing scopes inner first.
        const chain: ScopeModel[] = [];
        let current: SyntaxNode | null =
            clamped >= tree.rootNode.endIndex ? tree.rootNode : tree.rootNode.descendantForIndex(clamped);
        while (current && current.type !== 'source_file') {
            if (current.type === 'ERROR') {
                // Scopes inside an ERROR subtree are unreliable, drop them.
                chain.length = 0;
            } else {
                const entry = model.scopeByStart.get(current.startIndex);
                if (entry) chain.push(entry);
            }
            current = current.parent;
        }
        // The global scope is always in the chain.
        chain.push(model.scopes[0]);

        const result: ScopedItem[] = [];
        const seen = new Set<string>();
        for (const scope of chain) {
            for (const [name, defs] of scope.definitions) {
                if (seen.has(name)) continue;
                // The latest definition ending before the cursor wins.
                for (let i = defs.length - 1; i >= 0; i--) {
                    if (defs[i].end < clamped) {
                        result.push({
                            name,
                            kind: defs[i].kind,
                            isGlobal: scope.isGlobal,
                        });
                        seen.add(name);
                        break;
                    }
                }
            }
        }

        return result;
    }

    getReadCalls(document: vscode.TextDocument, position: vscode.Position): ReadCall[] {
        if (!isParserReady()) return [];

        const code = document.getText();
        if (code.length > SCOPED_CONTENT_LIMIT) return [];

        const tree = getDocumentTree(document, code);
        const model = this.getModel(document, tree);

        const offset = document.offsetAt(position);
        return model.readCalls.filter(call => call.end <= offset);
    }
}
