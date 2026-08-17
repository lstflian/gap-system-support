/**
 * Based on GAP's help search logic.
 *
 * Remarks:
 * 1. Sorting is handled by VS Code QuickPick.
 * 2. No duplicate entries are shown. GAP allows identical entries pointing to the same anchor.
 * 3. In prefix mode, these terms return no results because they have
 *    special meaning in GAP:
 *    `-` `+` `&` `<` `>` `<<` `>>` `books` `chapters` `contents` `sections` `welcome to gap`
 */

import { HelpEntry } from './indexData';
import { simpleString } from './simpleString';


/**
 * List of pairs of different spelling patterns
 * See https://github.com/gap-system/gap/blob/d2134de71521c62512b8351c42ec16bfbac21744/lib/helpbase.gi#L82-L106
 */
const TRANSATL: [string, string][] = [
    ['atalogue', 'atalog'],
    ['olour', 'olor'],
    ['entre', 'enter'],
    ['isation', 'ization'],
    ['ise', 'ize'],
    ['abeling', 'abelling'],
    ['olvable', 'oluble'],
    ['yse', 'yze'],
    ['roebner', 'robner'],
];

/**
 * Generate spelling alternatives for a topic string.
 * See https://github.com/gap-system/gap/blob/d2134de71521c62512b8351c42ec16bfbac21744/lib/helpbase.gi#L109-L248
 */
function helpSearchAlternatives(topic: string): string[] {
    interface MatchRec { start: number; finish: number; variant: string; pattern: string[]; }
    const positions: number[] = [];
    const patterns: MatchRec[] = [];

    // Step 1. find all TRANSATL matches in topic
    for (const pattern of TRANSATL) {
        const where: number[] = [];
        const what: MatchRec[] = [];

        for (const variant of pattern) {
            let pos = topic.indexOf(variant, 0);
            while (pos !== -1) {
                where.push(pos);
                what.push({ start: pos, finish: pos + variant.length - 1, variant, pattern });
                pos = topic.indexOf(variant, pos + variant.length);
            }
        }

        if (where.length > 0) {
            if (new Set(where).size === where.length) {
                positions.push(...where);
                patterns.push(...what);
            } else {
                const paired = where.map((w, i) => ({ w, m: what[i] }));
                paired.sort((a, b) => a.w - b.w);
                const newWhere: number[] = [paired[0].w];
                const newWhat: MatchRec[] = [paired[0].m];
                for (let i = 1; i < paired.length; i++) {
                    if (paired[i].w !== paired[i - 1].w) {
                        newWhere.push(paired[i].w);
                        newWhat.push(paired[i].m);
                    } else if (paired[i].m.variant.length > paired[i - 1].m.variant.length) {
                        newWhat[newWhat.length - 1] = paired[i].m;
                    }
                }
                positions.push(...newWhere);
                patterns.push(...newWhat);
            }
        }
    }

    // Step 2. build topics via Cartesian product
    let topics: string[];
    if (positions.length > 0) {
        const paired = positions.map((p, i) => ({ p, m: patterns[i] }));
        paired.sort((a, b) => a.p - b.p);

        const chop: string[][] = [];
        let begin = 0;
        for (const { p, m } of paired) {
            chop.push([topic.substring(begin, m.start)]);
            chop.push(m.pattern);
            begin = Math.min(m.finish, topic.length - 1) + 1;
        }
        if (begin <= topic.length) {
            chop.push([topic.substring(begin)]);
        }

        // Cartesian product
        topics = chop.reduce<string[]>((acc, seg) => {
            if (acc.length === 0) return seg;
            return acc.flatMap(a => seg.map(s => a + s));
        }, []);
    } else {
        topics = [topic];
    }

    // Step 3. Has/Set prefix stripping
    const r: string[] = [];
    for (const t of topics) {
        if (t.length > 4 && (t.startsWith('has') || t.startsWith('set')) && t[3] !== ' ') {
            const short = t.substring(3);
            r.push(short, 'has' + short, 'set' + short);
        } else {
            r.push(t);
        }
    }
    r.sort();
    return r;
}

/** 
 * Based on GAP's MATCH_BEGIN_COUNT
 * See https://github.com/gap-system/gap/blob/d2134de71521c62512b8351c42ec16bfbac21744/lib/helpbase.gi#L344-L393
 */
function mbc(a: string, b: string): number {
    if (a.length === 0 && b.length === 0) return 0;
    if (a.length < b.length) return -1;

    const p = b.indexOf(' ');
    if (p === -1) {
        let q = a.indexOf(' ');
        if (q === -1) q = a.length;
        const af = a.substring(0, q);
        if (b.length <= af.length && af.startsWith(b)) {
            return af.length === b.length ? 1 : 0;
        }
        return -1;
    } else {
        let q = a.indexOf(' ');
        if (q === -1) q = a.length + 1;
        const af = a.substring(0, q);
        const bf = b.substring(0, p);
        if (af.length < bf.length || !af.startsWith(bf)) return -1;
        const r = mbc(a.substring(q + 1), b.substring(p + 1));
        return r < 0 ? -1 : (p === q ? 1 + r : 0);
    }
}

/** Based on GAP's search logic. */
export function searchHelp(
    entries: HelpEntry[],
    topic: string,
    fromBegin: boolean = true
): HelpEntry[] {
    const normalized = simpleString(topic);
    if (!normalized) return [];

    // These are only intercepted in prefix mode.
    const SPECIAL = new Set(['-','+','&','<','>','<<','>>','books','chapters',
        'contents','sections','welcome to gap']);
    if (fromBegin && SPECIAL.has(normalized)) return [];
    if (fromBegin && /^\d+$/.test(normalized)) return [];

    const topics = normalized === 'size'
        ? [normalized]
        : helpSearchAlternatives(normalized);

    const seen = new Set<string>();
    const result: HelpEntry[] = [];

    for (const t of topics) {
        for (const e of entries) {
            if (e.key === t || (fromBegin ? mbc(e.key, t) >= 0 : e.key.includes(t))) {
                const id = `${e.book}|${e.chapter}|${e.section}|${e.anchor}|${e.display}`;
                if (seen.has(id)) continue;
                seen.add(id);
                result.push(e);
            }
        }
    }

    return result;
}
