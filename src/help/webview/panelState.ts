/**
 * Hold the state of one webview panel.
 * Store the current file, its directory, and the scroll position.
 * The reset method clears this instance only.
 */

import * as vscode from 'vscode';

export class HelpPanelSession {
    /** The underlying webview panel. */
    readonly panel: vscode.WebviewPanel;
    /** The doc folder path. */
    readonly docPath: string;
    /** The pkg folder path. */
    readonly pkgPath: string;

    /** The current HTML file with full path. */
    currentFile: string = '';
    /** The directory of the current file. */
    currentDocDir: string = '';

    /** The scroll position saved for re-renders. */
    lastScrollY: number | undefined;
    /** The exact scroll position saved when MathJax is toggled. */
    pendingScrollY: number | undefined;

    constructor(panel: vscode.WebviewPanel, docPath: string, pkgPath: string) {
        this.panel = panel;
        this.docPath = docPath;
        this.pkgPath = pkgPath;
    }

    /** Record the current file and its directory. */
    setFileState(file: string, docDir: string): void {
        this.currentFile = file;
        this.currentDocDir = docDir;
    }

    /** Clear the scroll position on navigation to another page. */
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
