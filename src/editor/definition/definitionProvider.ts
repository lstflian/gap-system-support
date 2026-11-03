import * as vscode from 'vscode';
import { getDocumentTree, isParserReady } from '../../language/parser/gapParser';
import { symbolLookupName, symbolNameNodeAt } from '../../language/analysis/symbols';
import { GAPDefinitionResolver } from '../analysis/definitionResolver';
import type { GAPReferenceProvider } from '../references/referenceProvider';

export class GAPDefinitionProvider implements vscode.DefinitionProvider {

    private resolver: GAPDefinitionResolver;

    constructor(
        completionPath: string,
        private readonly referenceProvider?: GAPReferenceProvider,
        resolver = new GAPDefinitionResolver(completionPath),
    ) {
        this.resolver = resolver;
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    onWorkspaceFilesChanged(): void {
        this.resolver.onWorkspaceFilesChanged();
    }

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Definition | vscode.DefinitionLink[]> {
        if (!isParserReady()) return undefined;

        // Only function and GAP symbol names qualify.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const node = symbolNameNodeAt(tree.rootNode, offset);
        if (!node) return undefined;

        const resolved = this.resolver.resolveDefinitions(
            document,
            position,
            symbolLookupName(node),
        );
        if (resolved.length === 0) return undefined;

        const selfDefinition = resolved.find(item => {
            const sameDocument =
                item.filePath === '' ||
                (process.platform === 'win32'
                    ? item.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                    : item.filePath === document.uri.fsPath);
            return sameDocument &&
                position.line === item.row &&
                position.character >= item.column &&
                position.character <= item.column + node.text.length;
        });
        if (selfDefinition) {
            const selfLink = this.selfDefinitionLink(
                document,
                position,
                node.text.length,
                selfDefinition,
            );
            if (this.referenceProvider) {
                return this.referenceProvider.provideReferences(
                    document,
                    position,
                    { includeDeclaration: true },
                    token,
                ).then(locations => locations.length > 0 ? locations : [selfLink]);
            }
            return [selfLink];
        }

        return resolved.map(item => {
            const sameDocument =
                item.filePath !== '' &&
                (process.platform === 'win32'
                    ? item.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                    : item.filePath === document.uri.fsPath);
            const uri = sameDocument || item.filePath === '' ? document.uri : vscode.Uri.file(item.filePath);
            return new vscode.Location(
                uri,
                new vscode.Range(
                    new vscode.Position(item.row, item.column),
                    new vscode.Position(item.row, item.column + node.text.length),
                ),
            );
        });
    }

    private selfDefinitionLink(
        document: vscode.TextDocument,
        position: vscode.Position,
        nameLength: number,
        definition: { filePath: string; row: number; column: number },
    ): vscode.LocationLink {
        const uri = definition.filePath === ''
            ? document.uri
            : vscode.Uri.file(definition.filePath);
        const zeroCharacter = position.character === definition.column
            ? definition.column + nameLength
            : definition.column;
        return {
            targetUri: uri,
            targetRange: new vscode.Range(
                new vscode.Position(definition.row, definition.column),
                new vscode.Position(definition.row, definition.column + nameLength),
            ),
            targetSelectionRange: new vscode.Range(
                new vscode.Position(definition.row, zeroCharacter),
                new vscode.Position(definition.row, zeroCharacter),
            ),
        };
    }
}
