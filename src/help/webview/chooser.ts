/**
 * Style chooser logic.
 * Pure functions with no vscode dependency.
 * This module computes values and builds the chooser shim script.
 */

import * as path from 'path';
import { escapeInlineJs } from './navScript';
import { tryReadFileWarn } from '../../shared/guarded';

export interface ParsedStyleValue {
    /** The dark or light value if chosen, empty otherwise. */
    appearance: string;
    /** The extra GAPDoc style options in order. */
    extras: string[];
    /** True when the value contains default. */
    hasDefault: boolean;
}

/** Split a chooser style value into appearance and extras. */
export function parseStyleValue(styleValue: string): ParsedStyleValue {
    const parts = styleValue.split(',').map(s => s.trim()).filter(Boolean);
    let appearance = '';
    const extras: string[] = [];
    for (const p of parts) {
        if (p === 'dark' || p === 'light') appearance = p;
        else if (p !== 'default') extras.push(p);
    }
    return { appearance, extras, hasDefault: parts.includes('default') };
}

/** Build the style value for rendering.
 *  The appearance is already resolved.
 */
export function buildRenderStyleValue(appearance: string, extraStyles: string): string {
    const parts = extraStyles ? extraStyles.split(',').map(s => s.trim()).filter(Boolean) : [];
    parts.unshift(appearance);
    return parts.join(',');
}

/** Build the style value for the chooser form.
 *  It reflects explicit settings only.
 */
export function buildChooserStyleValue(appearance: string, extraStyles: string): string {
    const parts = extraStyles ? extraStyles.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (appearance === 'dark' || appearance === 'light') parts.unshift(appearance);
    return parts.join(',');
}

const STYLE_PLACEHOLDER = 'STYLE_PLACEHOLDER';
const BACK_PLACEHOLDER = 'BACK_PLACEHOLDER';

// The shim script used in chooser pages.
// It is loaded once at module load time.
const CHOOSER_SHIM_JS = tryReadFileWarn(
    path.join(__dirname, '..', '..', '..', 'webresources', 'chooser-shim.js'),
    'chooser-shim.js',
);

/** Build the extra script for the page head of chooser.html. */
export function buildChooserShim(backTarget: string, styleValue: string): string {
    const safeBack = escapeInlineJs(backTarget);
    const safeStyle = escapeInlineJs(styleValue);
    // Strip the header comment and replace the placeholders.
    const js = CHOOSER_SHIM_JS
        .replace(/^\/\*[\s\S]*?\*\//, '')
        .replace(/STYLE_PLACEHOLDER|BACK_PLACEHOLDER/g, (m) =>
            m === STYLE_PLACEHOLDER ? safeStyle : safeBack);
    return `<script>\n${js}</script>`;
}

