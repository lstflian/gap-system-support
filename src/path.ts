/**
 * Path utilities for GAP files and help entries in the VS Code window.
 */

import * as os from 'os';
import * as vscode from 'vscode';
import { isBashOnWindowsShell, quoteShellPath, runtimePathFor } from './runtime/shellPaths';

export { resolveHelpPath } from './help/helpPaths';
export { quoteShellPath };

export function isBashOnWindows(): boolean {
    return isBashOnWindowsShell(vscode.env.shell);
}

/**
 * Return the change directory command for the terminal shell.
 * cmd needs /d to switch drives, other shells reject /d.
 */
export function shellCdCommand(): string {
    if (os.platform() !== 'win32') return 'cd';
    return /(^|[\\/])cmd(\.exe)?$/i.test(vscode.env.shell) ? 'cd /d' : 'cd';
}

export function toRuntimePath(fsPath: string, uri?: vscode.Uri): string {
    return runtimePathFor(fsPath, vscode.workspace.getConfiguration('gap', uri).get<string>('terminalRoot'), vscode.env.shell);
}

/** Return the file path as a safely quoted terminal argument. */
export function toShellPath(fsPath: string, uri?: vscode.Uri): string | undefined {
    return quoteShellPath(toRuntimePath(fsPath, uri));
}

/** Match the run command's choice of workspace root, including multi-root workspaces. */
export function getRunCwd(uri: vscode.Uri): vscode.Uri | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri;
}
