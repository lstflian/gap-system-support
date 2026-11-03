/**
 * Hold the state of one webview panel.
 * Store the current file, its directory, and the scroll position.
 * The reset method clears this instance only.
 */

import * as vscode from 'vscode';

export class HelpPanelSession {
    readonly panel: vscode.WebviewPanel;
    readonly docPath: string;
    readonly pkgPath: string;

    currentFile: string = '';
    currentDocDir: string = '';

    lastScrollY: number | undefined;
    pendingScrollY: number | undefined;

    constructor(panel: vscode.WebviewPanel, docPath: string, pkgPath: string) {
        this.panel = panel;
        this.docPath = docPath;
        this.pkgPath = pkgPath;
    }

    setFileState(file: string, docDir: string): void {
        this.currentFile = file;
        this.currentDocDir = docDir;
    }

    markPageChanged(): void {
        this.lastScrollY = undefined;
    }

    /** Reset all state of this instance only. */
    reset(): void {
        this.currentFile = '';
        this.currentDocDir = '';
        this.lastScrollY = undefined;
        this.pendingScrollY = undefined;
    }
}
