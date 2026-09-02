/**
 * Thin wrappers for user-facing notifications.
 * Message texts are passed through unchanged.
 * Prefixes are part of the message texts; none are added here.
 */

import * as vscode from 'vscode';
import { getErrorMessage } from './messages';

function resolveMessage(message: string | unknown): string {
    return typeof message === 'string' ? message : getErrorMessage(message);
}

/**
 * Show an error message.
 * Extra items are rendered as actions in the message.
 */
export function notifyError(message: string | unknown, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showErrorMessage(resolveMessage(message), ...items);
}

/**
 * Show a warning message.
 * Extra items are rendered as actions in the message.
 */
export function notifyWarning(message: string | unknown, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showWarningMessage(resolveMessage(message), ...items);
}

/**
 * Show an information message.
 * Extra items are rendered as actions in the message.
 */
export function notifyInfo(message: string | unknown, ...items: string[]): Thenable<string | undefined> {
    return vscode.window.showInformationMessage(resolveMessage(message), ...items);
}
