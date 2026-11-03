import * as vscode from 'vscode';
import type { LanguageHost } from '../language/documents';

export const languageHost: LanguageHost = {
    openDocuments: () => vscode.workspace.textDocuments,
    workspaceRoot: uri => vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri.toString()))?.uri.fsPath ?? null,
};
