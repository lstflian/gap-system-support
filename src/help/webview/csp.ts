/**
 * Content Security Policy for the webview.
 */

export function buildCSP(cspSource: string): string {
    const local = cspSource ? cspSource + ' ' : '';
    return [
        `default-src 'none';`,
        `img-src ${local}https: data:;`,
        `script-src ${local}https://cdn.jsdelivr.net 'unsafe-inline';`,
        `style-src ${local}'unsafe-inline';`,
        `font-src ${local}https://cdn.jsdelivr.net data:;`,
    ].join(' ');
}
