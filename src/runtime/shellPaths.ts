/**
 * Shell path conversion shared by the editor and the standalone MCP server.
 */

import * as os from 'os';

export function isBashOnWindowsShell(shell: string): boolean {
    if (os.platform() !== 'win32') return false;
    const value = shell.toLowerCase();
    return (value.includes('bash') && value.includes('windows')) || value.includes('wsl');
}

function toWslPath(path: string): string {
    return path
        .replace(/([A-Za-z]):\\/g, (_m, drive: string) => `/mnt/${drive.toLowerCase()}/`)
        .replace(/\\/g, '/');
}

function toCustomRoot(path: string, root: string): string {
    const prefix = root.endsWith('/') ? root : root + '/';
    return path
        .replace(/([A-Za-z]):\\/g, (_m, drive: string) => `${prefix}${drive.toLowerCase()}/`)
        .replace(/\\/g, '/');
}

/** Convert a host path to the path seen by the configured terminal shell. */
export function runtimePathFor(fsPath: string, terminalRoot: string | undefined, shell: string): string {
    if (terminalRoot) return toCustomRoot(fsPath, terminalRoot);
    if (isBashOnWindowsShell(shell)) return toWslPath(fsPath);
    return fsPath;
}

// Characters that a shell still interprets inside double quotes:
// " $ ` (bash, zsh, PowerShell), the curly quotes “ ” „ (PowerShell),
// ! (bash and zsh history), % (cmd) and control characters such as newline.
const UNSAFE_SHELL_CHARS = /["\u201C\u201D\u201E$`!%\x00-\x1F\x7F]/;

export function quoteShellPath(path: string): string | undefined {
    if (UNSAFE_SHELL_CHARS.test(path)) return undefined;
    // Double the trailing backslashes of a drive root such as D:\,
    // otherwise bash reads the last one as an escaped closing quote.
    return `"${path.replace(/\\+$/, '$&$&')}"`;
}
