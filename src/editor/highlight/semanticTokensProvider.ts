import * as vscode from 'vscode';
import { TOKEN_MODIFIERS, TOKEN_TYPES } from '../../language/semantic/captureMap';
import { SemanticAnalyzer } from '../../language/semantic/semanticAnalyzer';

export type { GlobalIndexMode, SemanticTokensProviderOptions } from '../../language/semantic/semanticAnalyzer';

export const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export class GAPSemanticTokensProvider extends SemanticAnalyzer implements vscode.DocumentRangeSemanticTokensProvider {
    async provideDocumentRangeSemanticTokens(document: vscode.TextDocument, range: vscode.Range,
        token: vscode.CancellationToken): Promise<vscode.SemanticTokens | null> {
        const entries = await this.getTokens(document, range, token);
        if (entries === null || token.isCancellationRequested) return null;
        const builder = new vscode.SemanticTokensBuilder(legend);
        for (const entry of entries) {
            if (token.isCancellationRequested) return null;
            if (entry.type === null) continue;
            builder.push(new vscode.Range(entry.line, entry.col, entry.line, entry.col + entry.text.length),
                entry.type, entry.modifiers);
        }
        return builder.build();
    }
}
