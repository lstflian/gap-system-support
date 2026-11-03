import type { LanguageHost, SourceDocument, SourceUri } from '../documents';
import { isParserReady, parseGapCode } from '../parser/gapParser';
import { BindingAnalysis, type ReadCall } from './bindings';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from './readFileCache';
import { GLOBAL_SCOPE } from './scopes';

interface LoadedFile {
    functions: string[];
    readPaths: string[];
}

export class GAPReadCompletions {

    private readonly analysis: BindingAnalysis;
    private readonly ownsAnalysis: boolean;
    private readonly fileCache: ReadChainFileCache<LoadedFile>;

    constructor(completionPath: string, private readonly host: LanguageHost, analysis?: BindingAnalysis) {
        this.analysis = analysis ?? new BindingAnalysis(completionPath);
        this.ownsAnalysis = analysis === undefined;
        this.fileCache = new ReadChainFileCache(content => this.parseFile(content), host);
    }

    onDocumentClosed(uri: SourceUri): void {
        this.fileCache.onDocumentClosed(uri);
    }

    dispose(): void {
        if (this.ownsAnalysis) this.analysis.dispose();
        this.fileCache.dispose();
    }

    getFunctionNames(document: SourceDocument, readCalls: ReadCall[]): string[] {
        if (!isParserReady() || readCalls.length === 0) return [];

        const baseDir = resolveReadBaseDir(document, this.host);
        if (!baseDir) return [];

        const names = new Set<string>();
        const visited = new Set<string>();
        for (const call of readCalls) {
            this.collect(call.path, baseDir, names, visited);
        }
        return [...names];
    }

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
            const facts = this.analysis.collect(tree.rootNode);
            return {
                functions: facts.bindings.filter(binding => binding.kind === 'function' && binding.scope === GLOBAL_SCOPE)
                    .map(binding => binding.name),
                readPaths: facts.readCalls.map(call => call.path),
            };
        } finally {
            tree.delete();
        }
    }
}
