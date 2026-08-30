/** Formatting helpers for hover content. */

import * as vscode from 'vscode';

/**
 * Normalize a filesystem path for display.
 * The VS Code URI machinery applies the platform casing and separators.
 */
export function toDisplayPath(p: string): string {
    return vscode.Uri.file(p).fsPath;
}

/**
 * Build a Go to Definition link whose text is the file path itself,
 * e.g. `[D:\\path\\file.g](command:gap.goToDefinition?... )`.
 */
export function definitionPathLink(filePath: string, row: number): string {
    const display = toDisplayPath(filePath);
    const payload = JSON.stringify([filePath, row]);
    return `[${display}](command:gap.goToDefinition?${encodeURIComponent(payload)})`;
}
