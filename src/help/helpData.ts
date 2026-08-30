/**
 * Help index data manager.
 * Holds the parsed help index in memory.
 * Copies the prebuilt index into the data directory.
 * Backs up and restores the export files during a rebuild.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadIndex, HelpEntry } from './indexData';

/** The three export files, in load order. */
const INDEX_FILES = ['export_gapdoc.txt', 'export_default.txt', 'export_text.txt'];

/** Timeouts for the rebuild scripts. */
export const EXPORT_GAPDOC_TIMEOUT_MS = 300_000;
export const EXPORT_TEXT_TIMEOUT_MS = 60_000;

// Parsed help index.
// `null` before the first load.
let entries: HelpEntry[] | null = null;
let bookDescriptions: Map<string, string> = new Map();
let dataDir = '';

/** The data directory for the help index. */
export function getHelpDataDir(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.globalStorageUri, 'data', 'helpIndex').fsPath;
}

/** The extension directory that holds the prebuilt index. */
function getBuiltinDataDir(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.extensionUri, 'data', 'helpIndex').fsPath;
}

/**
 * Copy the prebuilt index into the data directory.
 * All three export files are copied when any one is missing.
 */
export function ensureHelpIndex(context: vscode.ExtensionContext): void {
    dataDir = getHelpDataDir(context);
    const missing = INDEX_FILES.some(name => !fs.existsSync(path.join(dataDir, name)));
    if (!missing) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const builtin = getBuiltinDataDir(context);
    for (const name of INDEX_FILES) {
        fs.copyFileSync(path.join(builtin, name), path.join(dataDir, name));
    }
}

/**
 * Return the parsed help index.
 * The first call parses the export files.
 * Later calls return the cached entries.
 */
export function getHelpState(): { entries: HelpEntry[]; bookDescriptions: Map<string, string> } {
    if (entries === null && dataDir) {
        const loaded = loadIndex(dataDir);
        entries = loaded.entries;
        bookDescriptions = loaded.bookDescriptions;
    }
    return { entries: entries ?? [], bookDescriptions };
}

/**
 * Parse the export files again.
 * Replace the cached help index.
 */
export function reloadHelpIndex(): { entries: HelpEntry[]; bookDescriptions: Map<string, string> } {
    if (dataDir) {
        const loaded = loadIndex(dataDir);
        entries = loaded.entries;
        bookDescriptions = loaded.bookDescriptions;
    }
    return { entries: entries ?? [], bookDescriptions };
}

/** Backup suffix for the export files. */
const BAK_SUFFIX = '.bak';

/**
 * Rename each existing export file to a .bak backup.
 * Remove a leftover .bak before renaming.
 * Throw when a rename fails.
 */
export function backupHelpIndexData(): void {
    if (!dataDir) return;
    for (const name of INDEX_FILES) {
        const src = path.join(dataDir, name);
        if (!fs.existsSync(src)) continue;
        const bak = src + BAK_SUFFIX;
        try { fs.unlinkSync(bak); } catch {}
        fs.renameSync(src, bak);
    }
}

/**
 * Remove partially generated export files and restore the backups.
 * Only files with a backup are touched.
 * Drop the cached entries afterwards.
 */
export function restoreHelpIndexData(): void {
    if (!dataDir) return;
    for (const name of INDEX_FILES) {
        const dst = path.join(dataDir, name);
        const bak = dst + BAK_SUFFIX;
        if (!fs.existsSync(bak)) continue;
        try { fs.unlinkSync(dst); } catch {}
        try { fs.renameSync(bak, dst); } catch {}
    }
    // Drop the cached entries.
    entries = null;
}

/**
 * Delete the .bak backups.
 */
export function commitHelpIndexData(): void {
    if (!dataDir) return;
    for (const name of INDEX_FILES) {
        try { fs.unlinkSync(path.join(dataDir, name + BAK_SUFFIX)); } catch {}
    }
}
