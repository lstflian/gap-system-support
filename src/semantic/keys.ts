/**
 * Numeric key encodings for the token maps.
 */

/** Key multiplier, 16 million columns per line. */
const K = 1 << 24;

/** Encode a start position into one number key. */
export function posOuter(sl: number, sc: number): number {
    return sl * K + sc;
}

/** Encode a code unit range into one number key. */
export function byteKey(start: number, end: number): number {
    return start * K + end;
}

/** Decode a code unit range key. */
export function decodeByteKey(key: number): { start: number; end: number } {
    const start = Math.floor(key / K);
    return { start, end: key - start * K };
}
