/** Shared file loading for nested Read chains: open document reuse, size-limited reads, signature invalidation and an LRU parse cache. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LruCache } from './lruCache';
import { READ_CONTENT_LIMIT, READ_FILE_CACHE_MAX_ENTRIES } from '../limits';

/** Cached parse of one file, invalidated by a content signature. */
export interface ReadChainFileEntry<T> {
    signature: string;
    file: T | null;
}

/** Parses file content into the caller specific model. */
export type ParseReadChainFile<T> = (content: string) => T | null;

export class ReadChainFileCache<T> {

    // File cache, keyed by absolute path.
    private readonly cache = new LruCache<string, ReadChainFileEntry<T>>({
        maxEntries: READ_FILE_CACHE_MAX_ENTRIES,
    });
    private readonly parseFile: ParseReadChainFile<T>;

    constructor(parseFile: ParseReadChainFile<T>) {
        this.parseFile = parseFile;
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.cache.delete(uri.fsPath);
    }

    /** Read and parse one file with a content-based cache. */
    loadFile(filePath: string): T | null {
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
                if (stat.size > READ_CONTENT_LIMIT) return null;
                content = fs.readFileSync(filePath, 'utf-8');
            } catch {
                // Missing file, silently skip.
                return null;
            }
        }
        if (content.length > READ_CONTENT_LIMIT) return null;

        const cached = this.cache.peek(filePath);
        if (cached && cached.signature === signature) {
            this.cache.touch(filePath, cached);
            return cached.file;
        }

        const file = this.parseFile(content);
        this.cache.set(filePath, { signature, file });
        return file;
    }
}

/** Workspace folder path used as the base for Read path resolution. */
export function resolveReadBaseDir(document: vscode.TextDocument): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    return folder ? folder.uri.fsPath : null;
}

/** Resolve a Read path from the workspace base directory. */
export function resolveReadTarget(pathText: string, baseDir: string): string | null {
    const trimmed = pathText.trim();
    if (!trimmed) return null;
    if (trimmed.includes('\\')) return null;
    if (path.isAbsolute(trimmed)) return trimmed;
    const candidate = path.join(baseDir, trimmed);
    return fs.existsSync(candidate) ? candidate : null;
}
