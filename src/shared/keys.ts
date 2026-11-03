/**
 * Numeric key encodings for the token maps.
 */

const K = 1 << 24;

export function posOuter(sl: number, sc: number): number {
    return sl * K + sc;
}

export function byteKey(start: number, end: number): number {
    return start * K + end;
}

export function decodeByteKey(key: number): { start: number; end: number } {
    const start = Math.floor(key / K);
    return { start, end: key - start * K };
}
