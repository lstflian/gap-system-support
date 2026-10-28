/** Provide native Find All References and Peek References for GAP symbols. */

import * as vscode from 'vscode';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import { GAPDefinitionResolver } from '../hover/definitionResolver';
import type { ResolvedDefinition } from '../hover/definitionResolver';
import { symbolLookupName, symbolNameNodeAt } from '../shared/functionName';
import { READ_CONTENT_LIMIT } from '../limits';

const SOURCE_GLOB = '**/*.{g,gd,gi,gap}';
const EXCLUDE_GLOB = '**/{.git,node_modules,out}/**';
const WORKSPACE_URI_CACHE_MS = 5000;

interface SymbolIndex {
    version: number;
    symbols: Map<string, SyntaxNode[]>;
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

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
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
                    candidate.startPosition.row,
                    candidate.startPosition.column,
                );
                const location = new vscode.Location(
                    candidateDocument.uri,
                    new vscode.Range(
                        new vscode.Position(
                            candidate.startPosition.row,
                            candidate.startPosition.column,
                        ),
                        new vscode.Position(
                            candidate.endPosition.row,
                            candidate.endPosition.column,
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
                            candidate.startPosition.row,
                            candidate.startPosition.column,
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
    ): SyntaxNode[] {
        const key = document.uri.toString();
        const cached = this.symbolIndexCache.get(key);
        if (cached?.version === document.version) {
            return cached.symbols.get(lookupName) ?? [];
        }

        const tree = getDocumentTree(document, text);
        const symbols = new Map<string, SyntaxNode[]>();
        const visit = (node: SyntaxNode): void => {
            if (node.type === 'identifier' || node.type === 'string_content') {
                const classified = symbolNameNodeAt(tree.rootNode, node.startIndex);
                if (classified?.id === node.id) {
                    const name = symbolLookupName(node);
                    const entries = symbols.get(name);
                    if (entries) entries.push(node);
                    else symbols.set(name, [node]);
                }
            }
            for (const child of node.namedChildren) {
                if (child) visit(child);
            }
        };
        visit(tree.rootNode);
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
