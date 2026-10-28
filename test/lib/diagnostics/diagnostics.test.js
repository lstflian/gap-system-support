/**
 * Diagnostics tests: the compiled parser and the collector functions
 * never touch the vscode API, the mock only satisfies the import.
 */

const path = require('path');
const { installMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');

installMock();

const { initGapParser, parseGapCode } = require('../../../out/parser/gapParser');
const {
    collectErrorEntries,
    computeMissingStart,
} = require('../../../out/diagnostics/diagnosticsProvider');
const { checkSyntaxText } = require('../../../out/lmtools/toolCore');

/** Parse code and collect error entries. */
function errorsOf(code) {
    const tree = parseGapCode(code);
    try {
        if (!tree.rootNode.hasError) return [];
        return collectErrorEntries(tree.rootNode, code);
    } finally {
        tree.delete();
    }
}

/** Return whether an entry list has a `missing` entry with the given token. */
function hasMissing(entries, token) {
    return entries.some(e => e.kind === 'missing' && e.token === token);
}

/** Return whether an entry list has any `unexpected` entry. */
function hasUnexpected(entries) {
    return entries.some(e => e.kind === 'unexpected');
}

async function main() {
    await initGapParser({ extensionUri: { fsPath: path.join(__dirname, '..', '..', '..') } });

    section('1. Clean code produces no diagnostics');

    const clean = [
        'x := 1;',
        'if x > 0 then\n  y := 2;\nfi;',
        'for i in [1 .. 10] do\n  Print(i);\nod;',
        'f := function(a)\n  return a + 1;\nend;',
        'while true do\n  break;\nod;',
        'repeat\n  x := 1;\nuntil x = 1;',
        '# just a comment\n',
        'x := (2^3)^4;',
        'x := 2^(3^4);',
        'x := [1, ~];',
        'x := rec(a := ~);',
        '\\od := 1;',
        'f := function(x)\n  while x > 0 do\n    if x = 1 then break; fi;\n    x := x - 1;\n    continue;\n  od;\n  return x;\nend;',
        's := "中文😀";\r\nx := [1,2];\r\n',
    ];
    for (const code of clean) {
        const es = errorsOf(code);
        check(`clean code stays clean: ${JSON.stringify(code.slice(0, 24))}`, true, es.length === 0);
    }

    section('2. hasError gate');

    check('clean tree has hasError === false', false, parseGapCode('x := 1;\n').rootNode.hasError);
    check('broken tree has hasError === true', true, parseGapCode('x := ;\n').rootNode.hasError);

    section('3. Missing tokens');

    let es = errorsOf('x := 1\n');
    check('missing ; is reported', true, hasMissing(es, ';'));

    es = errorsOf('y := (1 + 2;\n');
    check('missing ) is reported', true, hasMissing(es, ')'));

    // Structural keyword misses (fi/then/do) yield one wrapping ERROR node, not MISSING nodes.
    es = errorsOf('if x then\n  y := 1;\n');
    check('missing fi yields exactly one unexpected entry', 1, es.length);
    check('missing fi snippet quotes the statement', true,
        es.length === 1 && es[0].snippet.startsWith('if x then'));

    section('4. Missing zero-width fallback');

    // MISSING nodes are zero-width at the insertion point.
    // The start backs up to the previous non-whitespace char so the squiggle is visible.
    es = errorsOf('x := 1\n');
    const semi = es.find(e => e.kind === 'missing' && e.token === ';');
    check('missing ; squiggle covers the 1 (not blank)', [5, 6],
        semi ? [semi.startIndex, semi.endIndex] : null);

    es = errorsOf('y := (1 + 2;\n');
    const paren = es.find(e => e.kind === 'missing' && e.token === ')');
    check('missing ) squiggle covers the previous 2', [10, 11],
        paren ? [paren.startIndex, paren.endIndex] : null);

    section('5. Unexpected syntax');

    es = errorsOf('x := ;;; ; ~~ @# $ @@ 1\n');
    check('garbage line yields unexpected entries', true, hasUnexpected(es));
    check('garbage line yields missing ; too', true, hasMissing(es, ';'));
    check('multiple sibling ERROR nodes are all reported', true,
        es.filter(e => e.kind === 'unexpected').length >= 2);

    section('6. Nested ERRORs preserve distinct ranges');

    // Recovery can place distinct ERROR nodes inside another ERROR.
    es = errorsOf('if x\n  y := 1;\nfi;\n');
    check('outer and nested ERROR ranges are both reported', [[0, 13], [7, 10]],
        es.filter(e => e.kind === 'unexpected').map(e => [e.startIndex, e.endIndex]));

    // The scanner can wrap an invalid character in two identical ERROR ranges.
    es = errorsOf('[1]!![1];\n');
    check('same-range ERROR nodes produce one diagnostic', [[3, 4]],
        es.filter(e => e.kind === 'unexpected').map(e => [e.startIndex, e.endIndex]));

    const errorTree = parseGapCode('if x then');
    try {
        es = collectErrorEntries(errorTree.rootNode.firstNamedChild, 'if x then');
        check('an ERROR passed as the root is reported', [[0, 9]],
            es.filter(e => e.kind === 'unexpected').map(e => [e.startIndex, e.endIndex]));
    } finally {
        errorTree.delete();
    }

    section('7. Missing tokens inside ERROR nodes');

    // Current upstream recovers this local declaration with nested ERRORs,
    // rather than the MISSING semicolon produced by the previous WASM.
    es = errorsOf('f := function()\nlocal x\nx := ;\n');
    check('upstream local recovery preserves both ERROR ranges', [[0, 30], [24, 28]],
        es.filter(e => e.kind === 'unexpected').map(e => [e.startIndex, e.endIndex]));
    check('local recovery does not invent a missing semicolon', false, hasMissing(es, ';'));

    const nestedMissing = [
        ['if x > 0 then\ny := [1,2]\nelse\ny := rec(a:=1);\n;\n', ';'],
        ['if true then\n  x := ;\n  y := ;\n', 'identifier'],
        ['if x > 0 then\ny := [1,2;\nelse\ny := rec(a:=1);\n;\n', ']'],
    ];
    for (const [code, token] of nestedMissing) {
        es = errorsOf(code);
        check(`outer ERROR remains visible with missing ${token}`, true, hasUnexpected(es));
        check(`missing ${token} inside ERROR is reported`, true, hasMissing(es, token));
        const result = checkSyntaxText(code);
        check(`shared syntax tool reports missing ${token}`, true,
            !result.syntaxValid && result.diagnostics.some(d => d.message === `Missing "${token}"`));
    }

    section('8. computeMissingStart offsets');

    check('backs up to previous non-space char', 5, computeMissingStart('x := 1   ', 9));
    check('file start stays zero-width anchor', 0, computeMissingStart('   x', 0));
    check('blank prefix before offset stays at anchor', 4, computeMissingStart('    ', 4));
    check('adjacent char (no spaces)', 1, computeMissingStart('ab', 2));

    section('9. Grammar-level checks');

    // Top-level `local` is invalid in GAP: the parser must produce an ERROR.
    es = errorsOf('local a, b;\n');
    check('top-level local is an ERROR', true, hasUnexpected(es));

    summary();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
