/**
 * Inject the navigation script into a page.
 * Replace the MathJax, scroll, and anchor placeholders.
 */

import * as fs from 'fs';
import * as path from 'path';

// The script used in every webview page.
const HELP_NAV_JS = (() => {
    try {
        return fs.readFileSync(path.join(__dirname, '..', '..', '..', 'webresources', 'help-nav.js'), 'utf-8');
    } catch (e: any) {
        console.warn(`GAP: Failed to load help-nav.js: ${e.message}`);
        return '';
    }
})();

/** Escape a string for inline use in a script tag. */
export function escapeInlineJs(s: string): string {
    return JSON.stringify(s).replace(/<\//gi, '<\\/');
}

/** Build the navigation script with an escaped anchor string. */
export function buildNavScript(anchor: string, extraHeadScript: string = '', mathJaxOn: boolean = true, scrollY?: number): string {
    // Escape the anchor string.
    const safe = escapeInlineJs(anchor);
    const mj = mathJaxOn ? 'on' : 'off';
    const sy = typeof scrollY === 'number' ? String(scrollY) : 'undefined';
    // Replace the anchor placeholder last.
    const js = HELP_NAV_JS
        .replace('MATHJAX_PLACEHOLDER', mj)
        .replace('SCROLLY_PLACEHOLDER', sy)
        .replace('ANCHOR_PLACEHOLDER', safe);
    return `<script>${js}</script>` + extraHeadScript;
}
