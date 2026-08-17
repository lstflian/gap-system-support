/**
 * This file does the following:
 * 
 * 1. Define the HelpEntry data structure.
 * 2. Parse three export files into HelpEntry arrays.
 */

import * as fs from 'fs';
import * as path from 'path';
import { simpleString } from './simpleString';

// Types

export interface HelpEntry {
    /** File path relative to the GAP root (empty for text-only) */
    filePath: string;
    /** Anchor ID (e.g. "X858ADA3B7A684421") */
    anchor: string;
    /** Display name */
    display: string;
    /** Normalized search key (via simpleString = GAP's SIMPLE_STRING) */
    key: string;
    /** Book name */
    book: string;
    /** Chapter number (entry[4] in GAP, -1 for GapDocGAP) */
    chapter: number;
    /** Section number (entry[5] in GAP, -1 for GapDocGAP) */
    section: number;
    /** True if this is a text-only entry */
    isTextOnly: boolean;
    /** Entry type (entry[3] in GAP): "S"=section, "C"=chapter, "F"=function, "I"=index. Empty for GapDocGAP. */
    type: string;
    /** Cleaned text content (only for text-only entries) */
    textContent?: string;
}

// Helpers

function cleanBookName(name: string): string {
    return name.replace(/\s*\(not loaded\)\s*/gi, '').trim();
}

function cleanText(text: string): string {
    return text.replace(/_{20,}/g, '───')
        .replace(/\\/g, '')
        .replace(/[ ]{2,}/g, ' '); 
}

/**
 * Read all three export files and parse into HelpEntry[].
 * Returns an object with entries array and bookDescriptions.
 */
export function loadIndex(dataDir: string): {
    entries: HelpEntry[];
    bookDescriptions: Map<string, string>;
} {
    const entries: HelpEntry[] = [];
    const bookDesc = new Map<string, string>();
    if (!fs.existsSync(dataDir)) return { entries, bookDescriptions: bookDesc };

    const gapdocFile  = path.join(dataDir, 'export_gapdoc.txt');
    const defaultFile = path.join(dataDir, 'export_default.txt');
    const textFile    = path.join(dataDir, 'export_text.txt');

    // 1. GapDocGAP (6 fields): bookDir|url|display|skey|bname|longname
    if (fs.existsSync(gapdocFile)) {
        const raw = fs.readFileSync(gapdocFile, 'utf-8');
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const p = line.split('|');
            if (p.length < 6) continue;
            const url = p[1], display = p[2], searchKey = p[3], bookName = p[4], longName = p[5];
            const hash = url.indexOf('#');
            const cleanedBook = cleanBookName(bookName);
            entries.push({
                filePath: url,
                anchor: hash >= 0 ? url.substring(hash + 1) : '',
                display,
                key: simpleString(searchKey),
                book: cleanedBook,
                chapter: -1,
                section: -1,
                type: '',
                isTextOnly: false,
            });
            if (!bookDesc.has(cleanedBook)) {
                bookDesc.set(cleanedBook, longName);
            }
        }
    }

    // 2. default handler (9 fields): bookDir|url|display|skey|bname|entry[4]|entry[5]|entry[3]|longname
    if (fs.existsSync(defaultFile)) {
        const raw = fs.readFileSync(defaultFile, 'utf-8');
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const p = line.split('|');
            if (p.length < 9) continue;
            const url = p[1], display = p[2], searchKey = p[3], bookName = p[4];
            const chapter = parseInt(p[5]) || 0;
            const section = parseInt(p[6]) || 0;
            const type = p[7] || '';
            const longName = p[8];
            const hash = url.indexOf('#');
            const cleanedBook = cleanBookName(bookName);
            entries.push({
                filePath: url,
                anchor: hash >= 0 ? url.substring(hash + 1) : '',
                display,
                key: simpleString(searchKey),
                book: cleanedBook,
                chapter,
                section,
                type,
                isTextOnly: false,
            });
            if (!bookDesc.has(cleanedBook)) {
                bookDesc.set(cleanedBook, longName);
            }
        }
    }

    // 3. Text-only (9 fields): bookDir|display|skey|bname|txt|entry[4]|entry[5]|entry[3]|longname
    if (fs.existsSync(textFile)) {
        const raw = fs.readFileSync(textFile, 'utf-8');
        const joined = raw.replace(/\r/g, '');
        const blocks = joined.split(/\n(?=\/[^\n|]+\|[^\n|]+\|[^\n|]+\|[^\n|]+\|)/);
        for (const block of blocks) {
            if (!block.trim()) continue;
            const line = block.replace(/\n/g, '');
            const p = line.split('|');
            if (p.length < 9) continue;
            const display = p[1], searchKey = p[2], bookName = p[3], textContent = p[4];
            const chapter = parseInt(p[5]) || 0;
            const section = parseInt(p[6]) || 0;
            const type = p[7] || '';
            const longName = p[8];
            const cleanedBook = cleanBookName(bookName);
            entries.push({
                filePath: '',
                anchor: '',
                display,
                key: simpleString(searchKey),
                book: cleanedBook,
                chapter,
                section,
                type,
                isTextOnly: true,
                textContent: cleanText(textContent.replace(/__NL__/g, '\n')),
            });
            if (!bookDesc.has(cleanedBook)) {
                bookDesc.set(cleanedBook, longName);
            }
        }
    }

    return { entries, bookDescriptions: bookDesc };
}
