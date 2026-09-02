/**
 * Native theme. 
 * Matches GAP's original browser look and renders text-only pages, pages without files, and HTML pages.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HelpEntry } from '../indexData';
import { buildCSP } from './csp';
import { resolveHelpPath } from '../../path';
import { tryReadFileWarn, tryValue } from '../../shared/guarded';
import { getErrorMessage, Messages } from '../../shared/messages';
import { notifyError } from '../../shared/notify';



/** Supports $...$, $$...$$, \\(...\\), \\[...\\] */
const MATHJAX_SNIPPET = [
    '<script>',
    'MathJax={tex:{inlineMath:[["$","$"],["\\\\(","\\\\)"]],displayMath:[["$$","$$"],["\\\\[","\\\\]"]]}};',
    '<\/script>',
    '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js" async><\/script>'
].join('\n');

/** Base style for fallback pages, which have no manual.css. */
const FALLBACK_BODY_STYLE = [
    'body{',
    'font-family:Helvetica,Verdana,Arial,sans-serif;',
    'padding:20px;',
    'color:var(--vscode-editor-foreground);',
    'background:var(--vscode-editor-background)',
    '}',
].join('');

/**
 * Injects the extra style options like toggless and times as link and script tags.
 * Skips files that do not exist.
 * toggless.js needs manual.js.
 */
function buildDocStyleTags(docDir: string, docStyle: string, toWebviewUri: (absPath: string) => string): string {
    const list = docStyle.split(',').map(s => s.trim()).filter(Boolean);
    let out = '';
    for (const s of list) {
        if (s === 'default' || s === 'light' || s === 'dark') continue;
        const css = path.join(docDir, s + '.css');
        if (!fs.existsSync(css)) continue;
        out += `<link rel="stylesheet" type="text/css" href="${toWebviewUri(css)}">`;
        if (s === 'toggless') {
            // Load toggless.js only when manual.js exists.
            const js = path.join(docDir, 'toggless.js');
            if (fs.existsSync(js) && fs.existsSync(path.join(docDir, 'manual.js'))) {
                out += `<script src="${toWebviewUri(js)}"></script>`;
            }
        }
    }
    return out;
}

/**
 * Injects the stylesheet for dark or light mode.
 * Docs with manual.css use the bundled gap-dark.css override in dark mode.
 * Docs without manual.css use the built-in appearance css.
 * Dark mode also gets dark-codeblock.css.
 */
function buildAppearanceTag(
    hasManualCSS: boolean,
    docStyle: string,
    toWebviewUri: (absPath: string) => string
): string {
    const parts = docStyle.split(',').map(s => s.trim()).filter(Boolean);
    const isDark = parts.includes('dark');
    const isLight = parts.includes('light');
    const resDir = RES_DIR;

    let baseTag = '';
    if (hasManualCSS) {
        // manual.css is light by default; only dark needs an override.
        if (!isDark) return '';
        const dark = path.join(resDir, 'gap-dark.css');
        if (fs.existsSync(dark)) {
            baseTag = `<link rel="stylesheet" type="text/css" href="${toWebviewUri(dark)}">`;
        }
        // If the override is missing, fall through to the fallback css below.
    } else if (!isDark && !isLight) {
        return '';
    }

    // Fallback css (no manual.css, or the override is missing).
    if (!baseTag) {
        const fbName = isDark ? 'appearance-dark.css' : isLight ? 'appearance-light.css' : '';
        if (!fbName) return '';
        const fb = path.join(resDir, fbName);
        if (fs.existsSync(fb)) {
            baseTag = `<link rel="stylesheet" type="text/css" href="${toWebviewUri(fb)}">`;
        }
    }

    if (isDark) {
        const cb = path.join(resDir, 'dark-codeblock.css');
        if (fs.existsSync(cb)) {
            baseTag += `<link rel="stylesheet" type="text/css" href="${toWebviewUri(cb)}">`;
        }
    }
    return baseTag;
}

export const native = {
    STYLE_NAME: 'native' as const,

    /** Render a help entry (text-only, no-file, or HTML) */
    renderEntry(
        entry: HelpEntry,
        docPath: string,
        pkgPath: string,
        cspSource: string,
        navScript: string,
        toWebviewUri: (absPath: string) => string,
        setFileState: (file: string, docDir: string) => void,
        docStyle: string = '',
        mathJax: boolean = true
    ): string | null {
        // Text-only entry
        if (entry.isTextOnly && entry.textContent) {
            const clean = String(entry.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<!DOCTYPE html><html><head>`
                + `<meta http-equiv="Content-Security-Policy" content="${buildCSP('')}">`
                + `<style>${FALLBACK_BODY_STYLE}body{white-space:pre-wrap}</style>`
                + (mathJax ? MATHJAX_SNIPPET : '')
                + `</head><body>${clean}</body></html>`;
        }

        // Entry without a file
        if (!entry.filePath) {
            return `<!DOCTYPE html><html><head>`
                + `<meta http-equiv="Content-Security-Policy" content="${buildCSP('')}">`
                + `<style>${FALLBACK_BODY_STYLE}</style>`
                + (mathJax ? MATHJAX_SNIPPET : '')
                + `</head><body><p>No documentation available.</p></body></html>`;
        }

        // HTML doc
        const file = resolveHelpPath(entry.filePath, docPath, pkgPath);
        if (!file || !fs.existsSync(file)) {
            const shown = file || entry.filePath;
            notifyError(Messages.helpWebview.fileNotFound(shown));
            return null;
        }
        const docDir = path.dirname(file);
        setFileState(file, docDir);
        return processHtmlFile(file, docDir, cspSource, navScript, toWebviewUri, docStyle, mathJax, docPath, pkgPath);
    },

    /** Render an HTML file for navigation */
    renderFile(
        filePath: string,
        docDir: string,
        docPath: string,
        pkgPath: string,
        cspSource: string,
        navScript: string,
        toWebviewUri: (absPath: string) => string,
        docStyle: string = '',
        mathJax: boolean = true
    ): string | null {
        return processHtmlFile(filePath, docDir, cspSource, navScript, toWebviewUri, docStyle, mathJax, docPath, pkgPath);
    },
};

// Internal helpers

// webresources is three levels above the compiled file.
const RES_DIR = path.join(__dirname, '..', '..', '..', 'webresources');
const HELP_SUPPLEMENT_CSS = tryReadFileWarn(path.join(RES_DIR, 'help-supplement.css'), 'help-supplement.css');

function buildStyleTags(html: string): { tags: string; hasManualCSS: boolean } {
    const hasManualCSS = /<link\b[^>]*\bhref=["'][^"']*\bmanual\.css(?=["'\s>])/i.test(html);
    let tags = '';
    if (hasManualCSS) {
        // Fix VS Code injected code background for GAP native docs
        tags = `<style>code,tt{background:transparent!important}</style>`;
    } else {
        // Use our supplement CSS for docs without manual.css
        tags = `<style>${HELP_SUPPLEMENT_CSS}</style>`;
    }
    return { tags, hasManualCSS };
}

function processHtmlFile(
    filePath: string,
    docDir: string,
    cspSource: string,
    navScript: string,
    toWebviewUri: (absPath: string) => string,
    docStyle: string = '',
    mathJax: boolean = true,
    docPath: string = '',
    pkgPath: string = ''
): string | null {
    return tryValue((): string | null => {
        let html = fs.readFileSync(filePath, 'utf-8');

        html = html.replace(/<script[^>]*src=["'][^"']*mathjax[^"']*["'][^>]*>\s*<\/script>/gi, '');

        // Seed GAPDocStyle cookie. Uses dark for dark mode, default otherwise.
        const hasDark = docStyle.split(',').map(s => s.trim()).filter(Boolean).includes('dark');
        const cookieValue = hasDark ? 'dark' : 'default';
        const cookieSeed = `<script>try{document.cookie="GAPDocStyle=${cookieValue};Path=/";}catch(e){}</script>`;
        // Suppress dynamically written stylesheet links and imports.
        const styleGuard = `<script>try{(function(){var ow=document.writeln.bind(document);document.writeln=function(s){if(typeof s==='string'){if(/@import/i.test(s)){return;}var m=/<link[^>]*href=["']([^"']+\.css)["']/i.exec(s);if(m&&!/^(https?:|data:|vscode-webview)/i.test(m[1])){return;}}ow(s);};})();}catch(e){}</script>`;
        html = html.replace(/<head[^>]*>/i, m => m + cookieSeed + styleGuard);

        const resolveLink = (rel: string) => {
            return toWebviewUri(path.resolve(docDir, rel));
        };

        html = html.replace(/\bsrc="(?!https?:\/\/|data:)([^"]+)"/gi, (_, rel) => {
            return `src="${resolveLink(rel)}"`;
        });
        html = html.replace(/\bsrc='(?!https?:\/\/|data:)([^']+)'/gi, (_, rel) => {
            return `src='${resolveLink(rel)}'`;
        });
        html = html.replace(/(<link\b[^>]*?\bhref)="(?!https?:\/\/|mailto:|data:)([^"]+)"/gi, (_, prefix, rel) => {
            return `${prefix}="${resolveLink(rel)}"`;
        });
        html = html.replace(/(<link\b[^>]*?\bhref)='(?!https?:\/\/|mailto:|data:)([^']+)'/gi, (_, prefix, rel) => {
            return `${prefix}='${resolveLink(rel)}'`;
        });
        const csp = buildCSP(cspSource);
        const parts = [`<meta http-equiv="Content-Security-Policy" content="${csp}">`];
        const { tags: styleTags, hasManualCSS: hasMC } = buildStyleTags(html);
        // Use the Markdown preview font size for the dark styles.
        const markdownSize = vscode.workspace.getConfiguration('markdown').get<number>('preview.fontSize', 14);
        parts.push(`<style>html{--markdown-font-size:${markdownSize}px;}</style>`);
        parts.push(styleTags, buildAppearanceTag(hasMC, docStyle, toWebviewUri), buildDocStyleTags(docDir, docStyle, toWebviewUri));
        if (mathJax) parts.push(MATHJAX_SNIPPET);
        parts.push(navScript, '</head>');
        const inject = parts.join('\n');
        const headClose = html.toLowerCase().lastIndexOf('</head>');
        if (headClose >= 0) {
            return html.slice(0, headClose) + inject + html.slice(headClose);
        }
        const headOpen = html.search(/<head[^>]*>/i);
        if (headOpen >= 0) {
            const m = /<head[^>]*>/i.exec(html);
            return html.slice(0, headOpen + m![0].length) + inject + html.slice(headOpen + m![0].length);
        }
        return html + inject;
    }, (e: any) => {
        notifyError(Messages.helpWebview.renderFailed(getErrorMessage(e)));
        return null;
    });
}
