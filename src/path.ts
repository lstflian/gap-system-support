/**
 * Path utilities for GAP files and help entries.
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Return whether the terminal shell is bash on Windows or WSL. */
function isBashOnWindows(): boolean {
    if (os.platform() !== 'win32') return false;
    const shell = vscode.env.shell.toLowerCase();
    return (shell.includes('bash') && shell.includes('windows')) || shell.includes('wsl');
}

/** Convert a Windows path to the /mnt/drive/ form that WSL uses. */
function toWslPath(path: string): string {
    return path
        .replace(/([A-Za-z]):\\/g, (_m, drive: string) => `/mnt/${drive.toLowerCase()}/`)
        .replace(/\\/g, '/');
}

/** Convert a Windows path to a custom Unix root, e.g. /mnt/ or /. */
function toCustomRoot(path: string, root: string): string {
    const prefix = root.endsWith('/') ? root : root + '/';
    return path
        .replace(/([A-Za-z]):\\/g, (_m, drive: string) => `${prefix}${drive.toLowerCase()}/`)
        .replace(/\\/g, '/');
}

/** Return the file path as a quoted string for the terminal. */
export function toShellPath(fsPath: string, uri?: vscode.Uri): string {
    const root = vscode.workspace.getConfiguration('gap', uri).get<string>('terminalRoot');
    let path = fsPath;
    if (root) {
        // Use the custom root that the user configured.
        path = toCustomRoot(fsPath, root);
    } else if (isBashOnWindows()) {
        // Use the default WSL root.
        path = toWslPath(fsPath);
    }
    return `"${path}"`;
}

/**
 * Resolve a help entry URL against the doc and pkg folders.
 * Strip the anchor suffix and the leading doc/pkg segment from the URL.
 * Return '' when the URL prefix or the folder is unknown.
 */
export function resolveHelpPath(url: string, docPath: string, pkgPath: string): string {
    const bare = url.replace(/#.*/, '');
    let root: string;
    if (bare.startsWith('/pkg/')) {
        root = pkgPath;
    } else if (bare.startsWith('/doc/')) {
        root = docPath;
    } else {
        return '';
    }
    if (!root) return '';
    const rel = bare.slice(5);
    return path.join(root, rel);
}
