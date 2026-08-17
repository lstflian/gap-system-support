/**
 * Navigate between help pages.
 * Resolve and apply the doc style values.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { native } from './native';
import {
    getDocAppearance, getDocStyles, getMathJax, setDocStyles, resolveAppearance,
    isVscodeThemeDark,
} from '../styleState';
import { buildNavScript } from './navScript';
import { buildChooserShim, parseStyleValue, buildRenderStyleValue, buildChooserStyleValue } from './chooser';
import { HelpPanelSession } from './panelState';
import { resolveHelpPath } from '../../path';

/** Turn a file path into a webview URL. */
function resolveUri(s: HelpPanelSession, abs: string): string {
    return s.panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString();
}

/**
 * Apply a chooser style value to settings and globalState.
 * Return the style value for rendering.
 */
function applyStyleFromChooser(styleValue: string): string {
    const { appearance, extras, hasDefault } = parseStyleValue(styleValue);
    const cfg = vscode.workspace.getConfiguration('gap');
    const current = cfg.get<string>('docAppearance') || 'system';
    const nextAppearance = appearance
        ? appearance
        : hasDefault ? 'system' : current;
    if (cfg.get<string>('docAppearance') !== nextAppearance) {
        void cfg.update('docAppearance', nextAppearance, vscode.ConfigurationTarget.Global);
    }
    setDocStyles(extras.join(','));
    // Resolve system against the theme.
    const resolved = nextAppearance === 'system'
        ? (isVscodeThemeDark() ? 'dark' : 'light')
        : nextAppearance;
    return [resolved, ...extras].join(',');
}

/** The style value for rendering. */
export function renderStyleValue(): string {
    return buildRenderStyleValue(resolveAppearance(), getDocStyles());
}

/** The style value for the chooser form. */
function chooserStyleValue(): string {
    return buildChooserStyleValue(getDocAppearance(), getDocStyles());
}

/** Open another HTML file or scroll to an anchor in the current one. */
export function navigatePage(s: HelpPanelSession, navFile: string, anchor: string, docStyle?: string, forceRender: boolean = false, scrollY?: number): void {
    if (!s.panel || !s.currentDocDir || !s.docPath) return;

    let styleValue = renderStyleValue();
    if (docStyle !== undefined && docStyle !== '') {
        styleValue = applyStyleFromChooser(docStyle);
    }

    // Support absolute, root relative (/pkg/), and relative links.
    const newFile = path.isAbsolute(navFile)
        ? navFile
        : navFile.startsWith('/')
            ? resolveHelpPath(navFile, s.docPath, s.pkgPath)
            : path.resolve(s.currentDocDir, navFile);
    if (!fs.existsSync(newFile)) {
        vscode.window.showWarningMessage(`GAP: File not found: ${navFile}`);
        return;
    }

    if (newFile === s.currentFile && !forceRender && docStyle === undefined) {
        if (anchor) s.panel.webview.postMessage({ type: 'scroll', anchor, key: '' });
        return;
    }

    // A new page clears the saved scroll position.
    if (newFile !== s.currentFile) s.markPageChanged();

    const isChooser = path.basename(newFile).toLowerCase() === 'chooser.html';
    const prevFile = s.currentFile;
    const prevDocDir = s.currentDocDir;
    s.currentFile = newFile;
    s.currentDocDir = path.dirname(newFile);

    let navScript: string;
    if (isChooser) {
        // The back target is the page we came from, relative to the chooser dir.
        const back = prevFile && prevFile !== newFile
            ? path.relative(path.dirname(newFile), prevFile).replace(/\\/g, '/')
            : '';
        navScript = buildNavScript(anchor, buildChooserShim(back, chooserStyleValue()), getMathJax());
    } else {
        navScript = buildNavScript(anchor, '', getMathJax(), scrollY);
    }

    let result: string | null = native.renderFile(newFile, s.currentDocDir, s.docPath, s.pkgPath, s.panel.webview.cspSource, navScript, (abs) => resolveUri(s, abs), styleValue, getMathJax());
    if (result) {
        s.panel.webview.html = result;
        s.panel.title = isChooser ? 'Style Chooser'
            : path.basename(newFile).replace(/^chap/, 'Chapter ').replace('.html', '');
    } else {
        // Roll back the state.
        s.currentFile = prevFile;
        s.currentDocDir = prevDocDir;
    }
}

/** Re-render the current page when the MathJax setting changes. */
export function refreshCurrentPage(s: HelpPanelSession): void {
    if (s.panel && s.currentFile) {
        const sy = s.pendingScrollY !== undefined ? s.pendingScrollY : s.lastScrollY;
        s.pendingScrollY = undefined;
        navigatePage(s, s.currentFile, '', undefined, true, sy);
    }
}
