/**
 * Core logic for the language model tools.
 * Computes search results, anchor lines and error messages.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HelpEntry } from '../help/indexData';
import { searchHelp } from '../help/searchEngine';
import { resolveHelpPath } from '../path';
import { tryValue } from '../shared/guarded';

/** Thrown when a tool cannot run; the message is returned to the model. */
export class ToolError extends Error {}

/** Wrap a tool body: ToolError becomes the result message, other errors rethrow. */
export function toolInvoke<T>(fn: () => T): vscode.LanguageModelToolResult {
    try {
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(fn(), null, 2)),
        ]);
    } catch (err) {
        if (err instanceof ToolError) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(err.message),
            ]);
        }
        throw err;
    }
}

/** Run fn, converting any error into a ToolError with the given message. */
export function toolTry<T>(fn: () => T, message: (err: unknown) => string): T {
    try {
        return fn();
    } catch (err) {
        throw new ToolError(message(err));
    }
}

export type SearchMode = 'prefix' | 'substring';

export interface SearchInput {
    topic: string;
    mode?: SearchMode;
    books?: string[];
    range?: [number, number];
}

export interface SearchResultEntry {
    index: number;
    display: string;
    /** Type name (type code mapped), omitted when the entry has no type code. */
    type?: string;
    /** Absolute file path, joined on the current platform with the same function the help panel uses. */
    absPath: string;
    /** 1-based start line; 0 means no anchor was located, so read the whole file (line 1 to totalLines). */
    targetLine: number;
    /** Total line count of the file. */
    totalLines: number;
}

export interface SearchOutput {
    results: SearchResultEntry[];
    total: number;
    returned: number;
    note: string;
    /** Book hit counts over all matches, sorted descending. Always present, empty for no matches. */
    distribution: Record<string, number>;
}

export interface BookInfo {
    name: string;
    fullName: string;
}

export interface ResolveLinkInput {
    /** Absolute path of the file currently being read. */
    filePath: string;
    /** Relative link (href) from that file; may contain '../' segments. */
    relativePath: string;
    /** Optional anchor to locate in the target file. */
    anchor?: string;
}

export interface ResolveLinkOutput {
    /** Resolved absolute path of the target file (native separators, same as absPath). */
    targetPath: string;
    /** 1-based start line; 0 means no anchor (read the whole file). */
    targetLine: number;
    /** Total line count of the target file. */
    totalLines: number;
    /** The matched anchor, or the input anchor if none was located. */
    anchor: string;
    /** Hint text; non-empty when the anchor is absent or was not found. */
    note: string;
}

export const DEFAULT_RESULT_LIMIT = 20;

/** Count matches per book, sorted by count descending then book name ascending. */
function bookDistribution(matched: HelpEntry[]): Record<string, number> {
    const counts = new Map<string, number>();
    for (const entry of matched) {
        counts.set(entry.book, (counts.get(entry.book) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const distribution: Record<string, number> = {};
    for (const [book, count] of sorted) distribution[book] = count;
    return distribution;
}

const TYPE_MAP: Record<string, string> = { F: 'function', S: 'section', C: 'chapter', I: 'index' };

export const CONFIG_MISSING_MESSAGE = (
    'gap.docPath and gap.pkgPath are not configured. Please set these two settings to the doc/ and pkg/ folders ' +
    'of your GAP installation. See the README of the gap-system-support extension (in your VS Code extensions ' +
    'folder: ~/.vscode/extensions/flianlee.gap-system-support-<version>/README.md).'
);

// Mirrors the webview anchor lookup: document.getElementById(anchor) || querySelector('[name=...]').
const ID_RE = /\b(?:id)\s*=\s*["']([^"'\s]+)["']/gi;
const NAME_RE = /\b(?:name)\s*=\s*["']([^"'\s]+)["']/gi;
// Fallback for legacy F entries whose anchor is not in the file.
const CODE_RE = /<\s*code\b[^>]*>([\s\S]*?)<\/code>/gi;

/** Count newline characters before the given position. */
function countNewlines(text: string, end: number): number {
    let count = 0;
    for (let i = 0; i < end && i < text.length; i++) {
        if (text.charCodeAt(i) === 10) count++;
    }
    return count;
}

/** 1-based line number of the position in the text. */
function lineNumberAt(text: string, index: number): number {
    return countNewlines(text, index) + 1;
}

/** Total line count of the text. */
function totalLines(text: string): number {
    return countNewlines(text, text.length) + 1;
}

/** Map a GAP entry type code to the response type name. */
function typeName(type: string): string | undefined {
    return TYPE_MAP[type];
}

/** Build the list_gap_books response, sorted by short name. */
export function listBooksOutput(bookDescriptions: Map<string, string>): { books: BookInfo[] } {
    const books: BookInfo[] = [];
    for (const [name, fullName] of bookDescriptions) {
        books.push({ name, fullName });
    }
    books.sort((a, b) => a.name.localeCompare(b.name));
    return { books };
}

/**
 * Resolve a relative link from a GAP help file to its absolute target path.
 * Only supports plain relative hrefs (no absolute or root-relative /doc/ /pkg/ forms).
 * Reuses scanFile/anchorLineOf for anchor locating, mirroring search_gap_help.
 */
export function resolveLinkOutput(input: ResolveLinkInput): ResolveLinkOutput {
    const filePath = input.filePath;
    const relativePath = input.relativePath;
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new ToolError('filePath is required and must be a non-empty string.');
    }
    if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
        throw new ToolError('relativePath is required and must be a non-empty string.');
    }
    const relative = relativePath.trim();
    const anchor = (input.anchor ?? '').trim();

    // External links are not resolved (no local file); suggest a web or other tool.
    if (/^(https?:\/\/|mailto:|data:)/i.test(relative)) {
        return {
            targetPath: relative,
            targetLine: 0,
            totalLines: 0,
            anchor,
            note: 'External link; not resolved to a local file. Use a web tool or other tool to fetch it.',
        };
    }

    // Resolve relative to the directory of the source file (same as the help panel).
    const targetPath = path.resolve(path.dirname(filePath), relative);

    // The target file may not exist; note it instead of failing.
    if (!fs.existsSync(targetPath)) {
        return {
            targetPath,
            targetLine: 0,
            totalLines: 0,
            anchor,
            note: `The target file does not exist: ${targetPath}`,
        };
    }

    // Always read the target file to get totalLines (and to locate the anchor).
    const scan = scanFile(targetPath);

    const output: ResolveLinkOutput = {
        targetPath,
        targetLine: 0,
        totalLines: scan.totalLines,
        anchor,
        note: '',
    };

    if (anchor) {
        const line = anchorLineOf(scan, anchor);
        if (line !== undefined) {
            output.targetLine = line;
        } else {
            // Treat as no anchor (no display/code fallback for links).
            output.note = 'The anchor was not found in the file; read line 1 to totalLines.';
        }
    } else {
        output.note = 'No anchor; this is the target file path; read line 1 to totalLines.';
    }

    return output;
}

/** Return an error message when any book name is unknown. */
function validateBooks(books: string[] | undefined, bookDescriptions: Map<string, string>): string | null {
    if (!books || books.length === 0) return null;
    const unknown = books.filter(b => !bookDescriptions.has(b));
    if (unknown.length === 0) return null;
    return `Unknown book name(s): ${unknown.join(', ')}. Call list_gap_books to get the valid book names.`;
}

/** Validate and parse the range argument. */
function parseRange(range: unknown): [number, number] | null {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const start = range[0];
    const end = range[1];
    if (typeof start !== 'number' || typeof end !== 'number') return null;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 1 || end < start) return null;
    return [start, end];
}

export interface FileScan {
    idLines: Map<string, number>;
    nameLines: Map<string, number>;
    codeLines: Map<string, number[]>;
    totalLines: number;
}

/** Scan one HTML file for id/name anchors and code elements. */
export function scanFile(absPath: string): FileScan {
    const text = tryValue(
        () => fs.readFileSync(absPath, 'utf-8'),
        (err) => {
            throw new ToolError(`Failed to read ${absPath}: ${(err as Error).message}`);
        },
    );
    const scan: FileScan = {
        idLines: new Map(),
        nameLines: new Map(),
        codeLines: new Map(),
        totalLines: totalLines(text),
    };
    for (const match of text.matchAll(ID_RE)) {
        const name = match[1];
        if (!scan.idLines.has(name)) {
            scan.idLines.set(name, lineNumberAt(text, match.index ?? 0));
        }
    }
    for (const match of text.matchAll(NAME_RE)) {
        const name = match[1];
        if (!scan.nameLines.has(name)) {
            scan.nameLines.set(name, lineNumberAt(text, match.index ?? 0));
        }
    }
    for (const match of text.matchAll(CODE_RE)) {
        const codeText = match[1];
        const line = lineNumberAt(text, match.index ?? 0);
        const lines = scan.codeLines.get(codeText);
        if (lines) {
            lines.push(line);
        } else {
            scan.codeLines.set(codeText, [line]);
        }
    }
    return scan;
}

/** Locate an anchor the way the webview does: getElementById(anchor) || querySelector('[name=...]'). */
export function anchorLineOf(scan: FileScan, anchor: string): number | undefined {
    const idLine = scan.idLines.get(anchor);
    if (idLine !== undefined) return idLine;
    const nameLine = scan.nameLines.get(anchor);
    if (nameLine !== undefined) return nameLine;
    return undefined;
}

/** Locate the entry line and how it was found, using the display fallback for legacy F entries. */
function anchorOfEntry(entry: HelpEntry, scan: FileScan): { line: number; source: 'anchor' | 'code' } | undefined {
    if (entry.anchor) {
        const line = anchorLineOf(scan, entry.anchor);
        if (line !== undefined) return { line, source: 'anchor' };
    }
    if (entry.anchor && !entry.anchor.startsWith('X') && entry.type === 'F' && entry.display) {
        for (const [codeText, lines] of scan.codeLines) {
            if (codeText.includes(entry.display)) return { line: lines[0], source: 'code' };
        }
    }
    return undefined;
}

/**
 * Run a help search and format the response.
 * Throws a ToolError for invalid input and unreadable files.
 */
export function searchHelpTool(
    input: SearchInput,
    entries: HelpEntry[],
    bookDescriptions: Map<string, string>,
    docPath: string,
    pkgPath: string,
    defaultMode: SearchMode,
): SearchOutput {
    const topic = input.topic;
    if (typeof topic !== 'string' || topic.trim().length === 0) {
        throw new ToolError('topic is required and must be a non-empty string.');
    }

    const mode = input.mode ?? defaultMode;
    if (mode !== 'prefix' && mode !== 'substring') {
        throw new ToolError('Invalid mode. Use "prefix" or "substring".');
    }

    const bookError = validateBooks(input.books, bookDescriptions);
    if (bookError) throw new ToolError(bookError);

    const range = parseRange(input.range);
    if (input.range !== undefined && !range) {
        throw new ToolError('Invalid range. Use a 1-based inclusive range like [1, 20] with 1 <= start <= end.');
    }

    const fromBegin = mode !== 'substring';
    const bookSet = input.books && input.books.length ? new Set(input.books) : null;
    const scoped = bookSet ? entries.filter(e => bookSet.has(e.book)) : entries;
    const matched = searchHelp(scoped, topic, fromBegin);
    const total = matched.length;

    if (total === 0) {
        return {
            results: [],
            total: 0,
            returned: 0,
            note: 'No matches. Try mode: substring or a different topic.',
            distribution: {},
        };
    }

    let start = 1;
    let end = Math.min(DEFAULT_RESULT_LIMIT, total);
    if (range) {
        start = range[0];
        end = Math.min(range[1], total);
    }

    if (start > total) {
        return {
            results: [],
            total,
            returned: 0,
            note: `Range start (${start}) exceeds the total (${total}). No entries in this range.`,
            distribution: bookDistribution(matched),
        };
    }

    const slice = matched.slice(start - 1, end);
    const scanCache = new Map<string, FileScan>();
    const results: SearchResultEntry[] = [];
    const noAnchorIndexes: number[] = [];
    const codeFallbackIndexes: number[] = [];

    for (let i = 0; i < slice.length; i++) {
        const entry = slice[i];
        // 1-based position in the full matched list, stable with `total` (text-only entries stay in `matched`).
        const index = start + i;

        // Text-only entries have no filePath/absPath and cannot be read by path.
        // Keep them in `matched` (so total/distribution count them) but skip them here.
        if (entry.isTextOnly || !entry.filePath) {
            continue;
        }

        // Same join as the help panel, so the output path matches the file that was read.
        const absPath = resolveHelpPath(entry.filePath, docPath, pkgPath);
        if (!absPath) {
            throw new ToolError(`Unknown help file path: ${entry.filePath} for entry '${entry.display}'.`);
        }

        const result: SearchResultEntry = {
            index,
            display: entry.display,
            absPath,
            targetLine: 0,
            totalLines: 0,
        };
        const t = typeName(entry.type);
        if (t) result.type = t;

        let scan = scanCache.get(absPath);
        if (!scan) {
            scan = scanFile(absPath);
            scanCache.set(absPath, scan);
        }
        result.totalLines = scan.totalLines;

        const found = anchorOfEntry(entry, scan);
        if (found) {
            result.targetLine = found.line;
            if (found.source === 'code') codeFallbackIndexes.push(index);
        } else {
            noAnchorIndexes.push(index);
        }
        results.push(result);
    }

    const noteLines: string[] = [];
    if (noAnchorIndexes.length > 0) {
        noteLines.push(`Entries [${noAnchorIndexes.join(', ')}] have no anchor; read the whole file.`);
    }
    if (codeFallbackIndexes.length > 0) {
        noteLines.push(
            `Entries [${codeFallbackIndexes.join(', ')}] have an anchor not found in the file; ` +
            'targetLine points to the first code element.'
        );
    }
    const remaining = total - results.length;
    if (remaining > 0) {
        const nextStart = end + 1;
        const nextEnd = Math.min(end + DEFAULT_RESULT_LIMIT, total);
        noteLines.push(
            `There are ${remaining} more matches not shown; page with range, e.g. [${nextStart}, ${nextEnd}].`
        );
    }

    const distribution = bookDistribution(matched);

    const output: SearchOutput = {
        results,
        total,
        returned: results.length,
        note: noteLines.join('\n'),
        distribution,
    };
    return output;
}
