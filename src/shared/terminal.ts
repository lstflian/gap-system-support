/**
 * Shared terminal helpers.
 */

import * as vscode from 'vscode';

/**
 * Resolve once the terminal closes, reject on timeout.
 * The timeout timer is cleared when the terminal closes first.
 */
export function waitTerminalClose(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const sub = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) {
                clearTimeout(timer);
                sub.dispose();
                resolve();
            }
        });
        timer = setTimeout(() => {
            sub.dispose();
            reject(new Error('timeout'));
        }, timeoutMs);
    });
}
