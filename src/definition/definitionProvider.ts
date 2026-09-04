/** Provide native Go to Definition for GAP user-defined functions. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { GAPDefinitionResolver } from '../hover/definitionResolver';
import { functionNameNodeAt } from '../shared/functionName';

export class GAPDefinitionProvider implements vscode.DefinitionProvider {

    private resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.Location | vscode.LocationLink[] | undefined {
        if (!isParserReady()) return undefined;

        // Only callees and function definition LHS names qualify.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const node = functionNameNodeAt(tree.rootNode, offset);
        if (!node) return undefined;

        const resolved = this.resolver.resolveDefinition(document, position, node.text);
        if (!resolved) return undefined;

        // Same-document hits reuse the document URI.
        // Read chain files use the disk path.
        const sameDocument =
            resolved.filePath !== '' &&
            (process.platform === 'win32'
                ? resolved.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                : resolved.filePath === document.uri.fsPath);
        const uri = sameDocument || resolved.filePath === '' ? document.uri : vscode.Uri.file(resolved.filePath);

        const targetRange = new vscode.Range(
            new vscode.Position(resolved.row, resolved.column),
            new vscode.Position(resolved.row, resolved.column + node.text.length),
        );

        // The cursor can sit on the definition name in the same document.
        // Return a LocationLink with a zero-width selection range.
        // The selection range never contains the cursor.

        // Anchor the selection point at the far end of the name.
        // This happens only when the cursor sits on the first character.
        if (sameDocument &&
            position.line === resolved.row &&
            position.character >= resolved.column &&
            position.character <= resolved.column + node.text.length) {
            const zeroCharacter = position.character === resolved.column
                ? resolved.column + node.text.length
                : resolved.column;
            return [{
                targetUri: uri,
                targetRange,
                targetSelectionRange: new vscode.Range(
                    new vscode.Position(resolved.row, zeroCharacter),
                    new vscode.Position(resolved.row, zeroCharacter),
                ),
            } as vscode.LocationLink];
        }

        return new vscode.Location(uri, targetRange);
    }
}
