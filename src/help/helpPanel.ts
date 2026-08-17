/**
 * Own the module level session pointer.
 * Route webview messages.
 * The dispose callback resets its own instance.
 */

import * as vscode from 'vscode';
import { HelpEntry } from './indexData';
import { native } from './webview/native';
import { getMathJax, setMathJax, getWebResourcesDir } from './styleState';
import { buildNavScript } from './webview/navScript';
import { navigatePage as navigateImpl, refreshCurrentPage as refreshImpl, renderStyleValue } from './webview/navigation';
import { HelpPanelSession } from './webview/panelState';

// The active session or null.
// This is the only module level state.
let session: HelpPanelSession | null = null;

/**
 * Re-render the current page.
 * Forward to the current session.
 */
export function refreshCurrentPage(): void {
    if (session) refreshImpl(session);
}

/**
 * Open a webview panel and show a help entry.
 */
export function showHelpPanel(entry: HelpEntry, docPath: string, pkgPath: string): void {
    if (session) { session.panel.dispose(); session = null; }

    const roots: vscode.Uri[] = [];
    if (docPath) roots.push(vscode.Uri.file(docPath));
    if (pkgPath && pkgPath !== docPath) roots.push(vscode.Uri.file(pkgPath));
    const webRes = getWebResourcesDir();
    if (webRes) roots.push(vscode.Uri.file(webRes));

    const panel = vscode.window.createWebviewPanel(
        'gapSystemHelp', 'GAP Help',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
            enableScripts: true, enableFindWidget: true,
            localResourceRoots: roots,
        }
    );
    session = new HelpPanelSession(panel, docPath, pkgPath);
    const thisSession = session;

    // Reset only this instance.
    panel.onDidDispose(() => { thisSession.reset(); });

    // Handle nav messages from the webview.
    panel.webview.onDidReceiveMessage(msg => {
        // Read the current session each time.
        const s = session;
        if (!s) return;
        if (msg.type === 'nav') {
            navigateImpl(s, msg.file, msg.anchor, msg.style);
        } else if (msg.type === 'scrollY') {
            s.lastScrollY = msg.y;
        } else if (msg.type === 'mathjax') {
            // Save the scroll position, then flip the switch.
            // The setting change triggers a re-render.
            s.pendingScrollY = typeof msg.scrollY === 'number' ? msg.scrollY : undefined;
            setMathJax(msg.on);
        }
    });
    panel.title = entry.display;

    // For F entries without an X anchor, append the display as the code search key.
    const placeholder = entry.anchor.startsWith('X') || entry.type !== 'F'
        ? entry.anchor
        : entry.anchor + '||' + entry.display;

    const navScript = buildNavScript(placeholder, '', getMathJax());

    let result: string | null = native.renderEntry(entry, docPath, pkgPath, panel.webview.cspSource, navScript,
        (abs) => panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString(),
        (file: string, docDir: string) => {
            thisSession.setFileState(file, docDir);
        }, renderStyleValue(), getMathJax());
    if (result) panel.webview.html = result;
}