/**
 * Search engine tests.
 * They run the real compiled searchEngine module.
 * No vscode dependency and no GAP installation needed.
 *
 * Usage: node test/lib/help/search.test.js   (run npm run compile first)
 */

const path = require('path');
const { check, section, summary } = require('./helpers');

const OUT = path.join(__dirname, '..', '..', '..', 'out');
const { searchHelp } = require(path.join(OUT, 'help', 'searchEngine.js'));
const { loadIndex } = require(path.join(OUT, 'help', 'indexData.js'));

/** Build a minimal help entry with a real GAP style key. */
function mkEntry(key, display, opts = {}) {
    return {
        filePath: 'doc/ref/chap1.html#X1',
        anchor: 'X1',
        display,
        key,
        book: 'Reference',
        chapter: 1,
        section: 1,
        type: 'F',
        isTextOnly: false,
        ...opts,
    };
}

/** Run a search and return the matched display names. */
function names(entries, topic, fromBegin = true) {
    return searchHelp(entries, topic, fromBegin).map(e => e.display);
}

section('1. Basic matching');

const basic = [
    mkEntry('semigroup', 'Semigroup'),
    mkEntry('semigroups', 'Semigroups'),
    mkEntry('group', 'Group'),
    mkEntry('monoid', 'Monoid'),
];

check('prefix matches semigroup and semigroups', ['Semigroup', 'Semigroups'], names(basic, 'semigroup'));
check('prefix match', ['Semigroup', 'Semigroups'], names(basic, 'semi'));
check('prefix no match', [], names(basic, 'WRONGTOPIC'));
check('substring match', ['Semigroup', 'Semigroups'], names(basic, 'emig', false));
check('uppercase topic normalized', ['Semigroup', 'Semigroups'], names(basic, 'SEMIGROUP'));

section('2. Spelling variants');

const spell = [
    mkEntry('color', 'Color'),
    mkEntry('realize', 'Realize'),
];

check('colour matches color', ['Color'], names(spell, 'colour'));
check('realise matches realize', ['Realize'], names(spell, 'realise'));

section('3. Has and Set prefix');

const hasSet = [
    mkEntry('isomorphism', 'Isomorphism'),
    mkEntry('setresidue', 'SetResidue'),
];

check('hasisomorphism matches isomorphism', ['Isomorphism'], names(hasSet, 'hasisomorphism'));
check('setisomorphism matches isomorphism', ['Isomorphism'], names(hasSet, 'setisomorphism'));

section('4. Special terms');

const special = [
    mkEntry('books', 'Books'),
    mkEntry('chapters', 'Chapters'),
    mkEntry('size', 'Size'),
];

check('books intercepted in prefix mode', [], names(special, 'books'));
check('chapters intercepted in prefix mode', [], names(special, 'chapters'));
check('numbers intercepted in prefix mode', [], names(special, '123'));
check('size still searchable', ['Size'], names(special, 'size'));

section('5. Deduplication');

const dup = [
    mkEntry('semigroup', 'Semigroup'),
    mkEntry('semigroup', 'Semigroup'),
    mkEntry('semigroup', 'Semigroup', { book: 'Another Book' }),
];

const dupResult = searchHelp(dup, 'semigroup', true).map(e => `${e.book}:${e.display}`);
check('same book deduplicated', ['Reference:Semigroup', 'Another Book:Semigroup'], dupResult);

section('6. Real prebuilt index smoke test');

const dataDir = path.join(__dirname, '..', '..', '..', 'data', 'helpIndex');
if (require('fs').existsSync(path.join(dataDir, 'export_default.txt'))) {
    const { entries } = loadIndex(dataDir);
    check('index loaded', true, entries.length > 10000);
    const sg = searchHelp(entries, 'semigroup', true);
    check('semigroup found in real index', true, sg.length > 0);
    check('semigroup result has file path', true, sg[0].filePath.length > 0);
    const sz = searchHelp(entries, 'size', true);
    check('size found in real index', true, sz.length > 0);
} else {
    console.log('  SKIP  prebuilt index not found');
}

summary();
