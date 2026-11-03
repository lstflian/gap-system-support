import * as vscode from 'vscode';
import { collectSymbolOccurrences, symbolLookupName, symbolNameNodeAt } from '../../language/analysis/symbols';
import type { SourceRange } from '../../language/documents';
import { getDocumentTree, isParserReady } from '../../language/parser/gapParser';
import { READ_CONTENT_LIMIT } from '../../limits';
import type { ResolvedDefinition } from '../analysis/definitionResolver';
import { GAPDefinitionResolver } from '../analysis/definitionResolver';

const SOURCE_GLOB = '**/*.{g,gd,gi,gap}';
const EXCLUDE_GLOB = '**/{.git,node_modules,out}/**';
const WORKSPACE_URI_CACHE_MS = 5000;

interface SymbolIndex {
    version: number;
    symbols: Map<string, SourceRange[]>;
}

function definitionKey(definition: ResolvedDefinition): string {
    return `${definition.filePath}:${definition.row}:${definition.column}`;
}

function locationKey(filePath: string, row: number, column: number): string {
    return `${filePath}:${row}:${column}`;
}

function definitionNameLength(lookupName: string): number {
    return lookupName.split(/[.!]/).filter(Boolean).pop()?.length ?? lookupName.length;
}

function isOriginLocation(
    document: vscode.TextDocument,
    position: vscode.Position,
    location: vscode.Location,
): boolean {
    if (location.uri.toString() !== document.uri.toString()) return false;
    const start = location.range.start;
    const end = location.range.end;
    if (position.line < start.line || position.line > end.line) return false;
    if (start.line === end.line) {
        return position.character >= start.character && position.character <= end.character;
    }
    if (position.line === start.line) return position.character >= start.character;
    if (position.line === end.line) return position.character <= end.character;
    return true;
}

export class GAPReferenceProvider implements vscode.ReferenceProvider {

    private readonly resolver: GAPDefinitionResolver;
    private readonly symbolIndexCache = new Map<string, SymbolIndex>();
    private readonly documentCache = new Map<string, vscode.TextDocument>();
    private readonly workspaceUriCache = new Map<string, { expiresAt: number; uris: vscode.Uri[] }>();

    constructor(completionPath: string, resolver = new GAPDefinitionResolver(completionPath)) {
        this.resolver = resolver;
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
        const key = uri.toString();
        this.symbolIndexCache.delete(key);
        this.documentCache.delete(key);
    }

    onWorkspaceFilesChanged(): void {
        this.workspaceUriCache.clear();
    }

    dispose(): void {
        this.symbolIndexCache.clear();
        this.documentCache.clear();
        this.workspaceUriCache.clear();
    }

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.Location[]> {
        if (!isParserReady() || token.isCancellationRequested) return [];

        const tree = getDocumentTree(document);
        const node = symbolNameNodeAt(tree.rootNode, document.offsetAt(position));
        if (!node) return [];
        const lookupName = symbolLookupName(node);
        const definitions = this.resolver.resolveDefinitions(document, position, lookupName);
        if (definitions.length === 0) return [];

        const originFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const originKey = locationKey(
            originFilePath,
            node.startPosition.row,
            node.startPosition.column,
        );
        const targetDefinitions = new Set(definitions.map(definitionKey));
        const definitionLocations = new Set(definitions.map(definitionKey));
        const documents = await this.workspaceDocuments(document, token);
        const locations: vscode.Location[] = [];
        const seen = new Set<string>();

        if (context.includeDeclaration) {
            for (const definition of definitions) {
                const key = definitionKey(definition);
                const definitionDocument = documents.find(candidate =>
                    definition.filePath === ''
                        ? candidate.uri.toString() === document.uri.toString()
                        : candidate.uri.fsPath === definition.filePath,
                );
                const uri = definitionDocument?.uri ??
                    (definition.filePath === '' ? document.uri : vscode.Uri.file(definition.filePath));
                const start = new vscode.Position(definition.row, definition.column);
                const location = new vscode.Location(
                    uri,
                    new vscode.Range(
                        start,
                        new vscode.Position(
                            definition.row,
                            definition.column + definitionNameLength(lookupName),
                        ),
                    ),
                );
                if (key === originKey || seen.has(key) ||
                    isOriginLocation(document, position, location)) continue;
                locations.push(location);
                seen.add(key);
            }
        }

        for (const candidateDocument of documents) {
            if (token.isCancellationRequested) return [];
            const text = candidateDocument.getText();
            if (text.length > READ_CONTENT_LIMIT) continue;
            const candidates = this.symbolsFor(candidateDocument, text, lookupName);
            for (const candidate of candidates) {
                if (token.isCancellationRequested) return [];
                const filePath = candidateDocument.isUntitled ? '' : candidateDocument.uri.fsPath;
                const key = locationKey(
                    filePath,
                    candidate.start.line,
                    candidate.start.character,
                );
                const location = new vscode.Location(
                    candidateDocument.uri,
                    new vscode.Range(
                        new vscode.Position(
                            candidate.start.line,
                            candidate.start.character,
                        ),
                        new vscode.Position(
                            candidate.end.line,
                            candidate.end.character,
                        ),
                    ),
                );
                if (key === originKey || isOriginLocation(document, position, location)) continue;
                const isDefinition = definitionLocations.has(key);
                if (isDefinition && !context.includeDeclaration) continue;

                // A same-named local definition shadows a workspace symbol.
                // If static lexical resolution finds a different definition,
                // this occurrence belongs to that local symbol instead.
                if (!isDefinition) {
                    const localDefinition = this.resolver.resolveDefinition(
                        candidateDocument,
                        new vscode.Position(
                            candidate.start.line,
                            candidate.start.character,
                        ),
                        lookupName,
                    );
                    if (localDefinition && !targetDefinitions.has(definitionKey(localDefinition))) {
                        continue;
                    }
                }

                if (seen.has(key)) continue;
                seen.add(key);
                locations.push(location);
            }
        }

        return locations.sort((left, right) =>
            left.uri.fsPath.localeCompare(right.uri.fsPath) ||
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character);
    }

    private symbolsFor(
        document: vscode.TextDocument,
        text: string,
        lookupName: string,
    ): SourceRange[] {
        const key = document.uri.toString();
        const cached = this.symbolIndexCache.get(key);
        if (cached?.version === document.version) {
            return cached.symbols.get(lookupName) ?? [];
        }

        const tree = getDocumentTree(document, text);
        const symbols = collectSymbolOccurrences(tree.rootNode);
        this.symbolIndexCache.set(key, { version: document.version, symbols });
        return symbols.get(lookupName) ?? [];
    }

    private async workspaceDocuments(
        current: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): Promise<vscode.TextDocument[]> {
        if (current.isUntitled || !vscode.workspace.getWorkspaceFolder(current.uri)) {
            return [current];
        }

        const workspace = vscode.workspace.getWorkspaceFolder(current.uri);
        if (!workspace) return [current];
        const workspaceKey = workspace.uri.toString();
        const now = Date.now();
        let cachedUris = this.workspaceUriCache.get(workspaceKey);
        if (!cachedUris || cachedUris.expiresAt <= now) {
            cachedUris = {
                expiresAt: now + WORKSPACE_URI_CACHE_MS,
                uris: await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB),
            };
            this.workspaceUriCache.set(workspaceKey, cachedUris);
        }
        const documents: vscode.TextDocument[] = [];
        const seen = new Set<string>();
        const add = (document: vscode.TextDocument): void => {
            const key = document.uri.toString();
            if (seen.has(key)) return;
            seen.add(key);
            documents.push(document);
        };
        add(current);

        for (const uri of cachedUris.uris) {
            if (token.isCancellationRequested) break;
            if (seen.has(uri.toString())) continue;
            try {
                const key = uri.toString();
                const cachedDocument = this.documentCache.get(key);
                if (cachedDocument) add(cachedDocument);
                else {
                    const opened = await vscode.workspace.openTextDocument(uri);
                    this.documentCache.set(key, opened);
                    add(opened);
                }
            } catch {
                // Files that disappear during a workspace search are skipped.
            }
        }
        return documents;
    }
}
