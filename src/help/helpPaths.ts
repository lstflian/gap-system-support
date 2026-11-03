import * as path from 'path';

/**
 * Resolve a help entry URL against the doc and pkg folders.
 * Strip the anchor suffix and the leading doc/pkg segment from the URL.
 * Return '' when the URL prefix or the folder is unknown.
 */
export function resolveHelpPath(url: string, docPath: string, pkgPath: string): string {
    const bare = url.replace(/#.*/, '');
    let root: string;
    if (bare.startsWith('/pkg/')) {
        root = pkgPath;
    } else if (bare.startsWith('/doc/')) {
        root = docPath;
    } else {
        return '';
    }
    if (!root) return '';
    const rel = bare.slice(5);
    return path.join(root, rel);
}
