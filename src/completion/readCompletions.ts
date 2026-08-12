/** Read("file.g") completions, following the Read chain recursively. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getGapLanguage, parseGapCode, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor } from '../semantic/locals';
import type { Query, QueryMatch, SyntaxNode } from 'web-tree-sitter';
import type { ReadCall } from './scoped';

/** Over this length (UTF-16 code units) a loaded file is skipped. */
const CONTENT_LENGTH_LIMIT = 1 * 1024 * 1024;

interface LoadedFile {
    functions: string[];
    /** Read paths as written in the file. */
    readPaths: string[];
}

/** Cached parse of one file, invalidated by a content signature. */
interface FileCacheEntry {
    signature: string;
    file: LoadedFile | null;
}

export class GapReadCompletions {

    private query: Query | null = null;
    private queryText: string;
    // File cache, keyed by absolute path.
    private fileCache = new Map<string, FileCacheEntry>();

    constructor(completionPath: string) {
        this.queryText = fs.readFileSync(completionPath, 'utf-8');
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.fileCache.delete(uri.fsPath);
    }

    private getQuery(): Query {
        if (!this.query) {
            this.query = getGapLanguage().query(this.queryText);
        }
        return this.query;
    }

    /** Collect user defined function names from the given Read calls. */
    getFunctionNames(document: vscode.TextDocument, readCalls: ReadCall[]): string[] {
        if (!isParserReady() || readCalls.length === 0) return [];

        const baseDir = this.resolveBaseDir(document);
        if (!baseDir) return [];

        const names = new Set<string>();
        const visited = new Set<string>();
        for (const call of readCalls) {
            this.collect(call.path, baseDir, names, visited);
        }
        return [...names];
    }

    private resolveBaseDir(document: vscode.TextDocument): string | null {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        return folder ? folder.uri.fsPath : null;
    }

    /** Load one file, then recurse into its Read calls. */
    private collect(
        pathText: string,
        baseDir: string,
        names: Set<string>,
        visited: Set<string>,
    ): void {
        const target = this.resolveTarget(pathText, baseDir);
        if (!target) return;

        const key = target;
        // Cycle guard: each absolute path is visited once.
        if (visited.has(key)) return;
        visited.add(key);

        const loaded = this.loadFile(key);
        if (!loaded) return;

        for (const name of loaded.functions) names.add(name);
        // Nested Reads use the same base directory.
        for (const p of loaded.readPaths) {
            this.collect(p, baseDir, names, visited);
        }
    }

    /** Resolve a Read path: reject backslashes, keep absolute paths, join others to baseDir. */
    private resolveTarget(pathText: string, baseDir: string): string | null {
        const trimmed = pathText.trim();
        if (!trimmed) return null;
        if (trimmed.includes('\\')) return null;
        if (path.isAbsolute(trimmed)) return trimmed;
        const candidate = path.join(baseDir, trimmed);
        return fs.existsSync(candidate) ? candidate : null;
    }

    /** Read and parse one file, cached by a content signature. */
    private loadFile(filePath: string): LoadedFile | null {
        const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === filePath);
        let content: string;
        let signature: string;
        if (open) {
            content = open.getText();
            signature = `doc:${open.version}`;
        } else {
            try {
                const stat = fs.statSync(filePath);
                signature = `file:${stat.mtimeMs}:${stat.size}`;
                if (stat.size > CONTENT_LENGTH_LIMIT) return null;
                content = fs.readFileSync(filePath, 'utf-8');
            } catch {
                // Missing file, silently skip.
                return null;
            }
        }
        if (content.length > CONTENT_LENGTH_LIMIT) return null;

        const cached = this.fileCache.get(filePath);
        if (cached && cached.signature === signature) {
            this.fileCache.delete(filePath);
            this.fileCache.set(filePath, cached);
            return cached.file;
        }

        const file = this.parseFile(content);
        this.fileCache.delete(filePath);
        this.fileCache.set(filePath, { signature, file });
        // Bound the cache size, least recently used first.
        if (this.fileCache.size > 64) {
            const first = this.fileCache.keys().next().value;
            if (first !== undefined) this.fileCache.delete(first);
        }
        return file;
    }

    /** Parse one file, collect user defined functions and Read paths. */
    private parseFile(content: string): LoadedFile | null {
        const tree = parseGapCode(content);
        try {
            const matches = this.getQuery().matches(tree.rootNode);
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

/** Whether the node is defined outside any enclosing function body. */
function isTopLevel(node: SyntaxNode): boolean {
    let current: SyntaxNode | null = node.parent;
    while (current && current.type !== 'source_file') {
        if (current.type === 'function' || current.type === 'lambda' || current.type === 'atomic_function') {
            return false;
        }
        current = current.parent;
    }
    return true;
}
