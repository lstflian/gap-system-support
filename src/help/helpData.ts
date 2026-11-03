/**
 * Help index data manager.
 * Holds the parsed help index in memory.
 * Copies the prebuilt index into the data directory.
 * Backs up and restores the export files during a rebuild.
 */

import * as fs from 'fs';
import * as path from 'path';
import { safeRename, safeUnlink } from '../shared/guarded';
import { HelpEntry, loadIndex } from './indexData';

/** The parts of the extension context that locate the help index; also usable without VS Code. */
export interface HelpDataContext {
    readonly globalStorageUri: { readonly fsPath: string };
    readonly extensionUri: { readonly fsPath: string };
}

/** The three export files, in load order. */
const INDEX_FILES = ['export_gapdoc.txt', 'export_default.txt', 'export_text.txt'];

export const EXPORT_GAPDOC_TIMEOUT_MS = 300_000;
export const EXPORT_TEXT_TIMEOUT_MS = 60_000;

// Parsed help index.
// `null` before the first load.
let entries: HelpEntry[] | null = null;
let bookDescriptions: Map<string, string> = new Map();
let dataDir = '';
let loadedSignature = '';

export function getHelpDataDir(context: HelpDataContext): string {
    return path.join(context.globalStorageUri.fsPath, 'data', 'helpIndex');
}

function getBuiltinDataDir(context: HelpDataContext): string {
    return path.join(context.extensionUri.fsPath, 'data', 'helpIndex');
}

function indexSignature(): string {
    return INDEX_FILES.map(name => {
        try {
            const stat = fs.statSync(path.join(dataDir, name));
            return `${stat.mtimeMs}:${stat.size}`;
        } catch {
            return 'missing';
        }
    }).join('|');
}

function load(): void {
    loadedSignature = indexSignature();
    const loaded = loadIndex(dataDir);
    entries = loaded.entries;
    bookDescriptions = loaded.bookDescriptions;
}

/**
 * Copy the prebuilt index into the data directory.
 * All three export files are copied when any one is missing.
 */
export function ensureHelpIndex(context: HelpDataContext): void {
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
    if (entries === null && dataDir) load();
    return { entries: entries ?? [], bookDescriptions };
}

/**
 * Parse the export files again.
 * Replace the cached help index.
 */
export function reloadHelpIndex(): { entries: HelpEntry[]; bookDescriptions: Map<string, string> } {
    if (dataDir) load();
    return { entries: entries ?? [], bookDescriptions };
}

/**
 * Drop the cached entries when another process rewrote the export files,
 * so a long-lived MCP server sees a help index rebuilt in a VS Code window.
 */
export function invalidateHelpIndexIfChanged(): void {
    if (entries !== null && dataDir && indexSignature() !== loadedSignature) entries = null;
}

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
        safeUnlink(bak);
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
        safeUnlink(dst);
        safeRename(bak, dst);
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
        safeUnlink(path.join(dataDir, name + BAK_SUFFIX));
    }
}
