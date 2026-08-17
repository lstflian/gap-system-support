/**
 * Central state for GAPDoc styles.
 * The appearance and the MathJax switch live in VS Code settings.
 * The remaining style options live in globalState and persist.
 */

import * as vscode from 'vscode';
import * as path from 'path';

/** Key for globalState. */
export const GLOBAL_STYLE_KEY = 'gapHelp.docStyle';

let globalContext: vscode.ExtensionContext | null = null;
let webResourcesDir: string = '';

/** Store the extension context and the webresources path. */
export function initStyleState(ctx: vscode.ExtensionContext): void {
    globalContext = ctx;
    webResourcesDir = path.join(ctx.extensionPath, 'webresources');
}

/** Absolute path of the extension's webresources/ directory. */
export function getWebResourcesDir(): string {
    return webResourcesDir;
}

/** Resolved appearance taking the VS Code theme into account. */
export type ResolvedAppearance = 'dark' | 'light';

export function getDocAppearance(): string {
    const cfg = vscode.workspace.getConfiguration('gap');
    return (cfg.get<string>('docAppearance') || 'system').trim();
}

/** True if the theme kind is Dark or HighContrast. */
export function isVscodeThemeDark(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

/** 'dark' or 'light' after resolving 'system' against the VS Code theme. */
export function resolveAppearance(): ResolvedAppearance {
    const a = getDocAppearance();
    if (a === 'dark' || a === 'light') return a;
    return isVscodeThemeDark() ? 'dark' : 'light';
}

/** Comma-separated extra styles from globalState ('' if none). */
export function getDocStyles(): string {
    return globalContext?.globalState.get<string>(GLOBAL_STYLE_KEY, '') ?? '';
}

export function setDocStyles(styles: string): void {
    if (globalContext) {
        void globalContext.globalState.update(GLOBAL_STYLE_KEY, styles);
    }
}

/** MathJax switch: settings value. */
export function getMathJax(): boolean {
    const cfg = vscode.workspace.getConfiguration('gap');
    return cfg.get<boolean>('mathJax', true);
}

export function setMathJax(on: boolean): void {
    const cfg = vscode.workspace.getConfiguration('gap');
    void cfg.update('mathJax', on, vscode.ConfigurationTarget.Global);
}
