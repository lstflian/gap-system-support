/** Resolve function names from nested Read files. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { parseGapCode, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor, isTopLevel } from '../shared/treeUtils';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from '../shared/readFileCache';
import { LazyQuery } from '../shared/lazyQuery';
import type { ReadCall } from './scoped';

interface LoadedFile {
    functions: string[];
    /** Read paths as written in the file. */
    readPaths: string[];
}

export class GapReadCompletions {

    private readonly query: LazyQuery;
    private readonly fileCache = new ReadChainFileCache<LoadedFile>(content => this.parseFile(content));

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf-8'));
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.fileCache.onDocumentClosed(uri);
    }

    /** Collect user-defined function names from the Read chain. */
    getFunctionNames(document: vscode.TextDocument, readCalls: ReadCall[]): string[] {
        if (!isParserReady() || readCalls.length === 0) return [];

        const baseDir = resolveReadBaseDir(document);
        if (!baseDir) return [];

        const names = new Set<string>();
        const visited = new Set<string>();
        for (const call of readCalls) {
            this.collect(call.path, baseDir, names, visited);
        }
        return [...names];
    }

    /** Load one file and recurse through its Read calls. */
    private collect(
        pathText: string,
        baseDir: string,
        names: Set<string>,
        visited: Set<string>,
    ): void {
        const target = resolveReadTarget(pathText, baseDir);
        if (!target) return;

        const key = target;
        // Cycle guard: each absolute path is visited once.
        if (visited.has(key)) return;
        visited.add(key);

        const loaded = this.fileCache.loadFile(key);
        if (!loaded) return;

        for (const name of loaded.functions) names.add(name);
        // Nested Reads use the same base directory.
        for (const p of loaded.readPaths) {
            this.collect(p, baseDir, names, visited);
        }
    }

    private parseFile(content: string): LoadedFile | null {
        const tree = parseGapCode(content);
        try {
            const matches = this.query.get().matches(tree.rootNode);
            const functions: string[] = [];
            const readPaths: string[] = [];
            for (const match of matches) {
                let readPath = '';
                let readFn = '';
                for (const capture of match.captures) {
                    const node = capture.node;
                    const name = capture.name;
                    if (name === 'completion.read-fn') {
                        if (!hasErrorAncestor(node)) readFn = node.text;
                    } else if (name === 'completion.read-path') {
                        if (!hasErrorAncestor(node)) readPath = node.text;
                    } else if (name === 'completion.function') {
                        if (!hasErrorAncestor(node) && isTopLevel(node)) {
                            functions.push(node.text);
                        }
                    }
                }
                if (readFn === 'Read' && readPath) readPaths.push(readPath);
            }
            return { functions, readPaths };
        } finally {
            tree.delete();
        }
    }
}
