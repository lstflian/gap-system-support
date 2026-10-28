/**
 * Path utilities for GAP files and help entries.
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Return whether the terminal shell is bash on Windows or WSL. */
export function isBashOnWindows(): boolean {
    if (os.platform() !== 'win32') return false;
    const shell = vscode.env.shell.toLowerCase();
    return (shell.includes('bash') && shell.includes('windows')) || shell.includes('wsl');
}

/**
 * Return the change directory command for the terminal shell.
 * cmd needs /d to switch drives, other shells reject /d.
 */
export function shellCdCommand(): string {
    if (os.platform() !== 'win32') return 'cd';
    return /(^|[\\/])cmd(\.exe)?$/i.test(vscode.env.shell) ? 'cd /d' : 'cd';
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

// Characters that a shell still interprets inside double quotes:
// " $ ` (bash, zsh, PowerShell), the curly quotes “ ” „ (PowerShell),
// ! (bash and zsh history), % (cmd) and control characters such as newline.
const UNSAFE_SHELL_CHARS = /["\u201C\u201D\u201E$`!%\x00-\x1F\x7F]/;

/** Convert to the configured GAP runtime's path syntax, without shell quoting. */
export function toRuntimePath(fsPath: string, uri?: vscode.Uri): string {
    const root = vscode.workspace.getConfiguration('gap', uri).get<string>('terminalRoot');
    let path = fsPath;
    if (root) {
        // Use the custom root that the user configured.
        path = toCustomRoot(fsPath, root);
    } else if (isBashOnWindows()) {
        // Use the default WSL root.
        path = toWslPath(fsPath);
    }
    return path;
}

export function quoteShellPath(path: string): string | undefined {
    if (UNSAFE_SHELL_CHARS.test(path)) return undefined;
    // Double the trailing backslashes of a drive root such as D:\,
    // otherwise bash reads the last one as an escaped closing quote.
    return `"${path.replace(/\\+$/, '$&$&')}"`;
}

/** Return the file path as a safely quoted terminal argument. */
export function toShellPath(fsPath: string, uri?: vscode.Uri): string | undefined {
    return quoteShellPath(toRuntimePath(fsPath, uri));
}

/** Match the run command's choice of workspace root, including multi-root workspaces. */
export function getRunCwd(uri: vscode.Uri): vscode.Uri | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri;
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
