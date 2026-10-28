/** Parser compatibility and recovery tests using the bundled GAP WASM. */

'use strict';
const assert = require('assert/strict');
const path = require('path');
const treeSitter = require('web-tree-sitter');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');

installMock();

const parser = require('../../../out/parser/gapParser');
const { Messages } = require('../../../out/shared/messages');

/** Simulate a cancelled parse and count resets, restoring the runtime afterward. */
function withNullParse(run) {
    const { parse, reset } = treeSitter.Parser.prototype;
    let resets = 0;
    treeSitter.Parser.prototype.parse = () => null;
    treeSitter.Parser.prototype.reset = function () {
        resets++;
        return reset.call(this);
    };
    try {
        run();
    } finally {
        treeSitter.Parser.prototype.parse = parse;
        treeSitter.Parser.prototype.reset = reset;
    }
    return resets;
}

function positionAt(text, offset) {
    const lines = text.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

async function main() {
    try {
        await parser.initGapParser({ extensionUri: { fsPath: path.join(__dirname, '..', '..', '..') } });

        section('1. Runtime and bundled language compatibility');
        const abi = parser.getGapLanguage().abiVersion;
        check('bundled language uses the current upstream ABI', 15, abi);
        check('bundled language ABI is supported by the runtime', true,
            abi >= treeSitter.MIN_COMPATIBLE_VERSION && abi <= treeSitter.LANGUAGE_VERSION);
        const empty = parser.parseGapCode('');
        try {
            check('empty source has a clean source_file root', ['source_file', false, 0],
                [empty.rootNode.type, empty.rootNode.hasError, empty.rootNode.endIndex]);
        } finally {
            empty.delete();
        }

        section('2. Incremental parsing preserves UTF-16 offsets and CRLF positions');
        let text = 's := "中文😀";\r\nx := (1 + 2);\r\n';
        const uri = vscodeMock.Uri.file(path.join(__dirname, 'incremental.g'));
        const document = { uri, version: 1, getText: () => text };
        const original = parser.getDocumentTreeSnapshot(document);
        const offset = text.indexOf(')');
        const start = positionAt(text, offset);
        const end = positionAt(text, offset + 1);
        parser.onDocumentChanged(uri, [{
            rangeOffset: offset, rangeLength: 1, range: { start, end }, text: '',
        }]);
        text = text.slice(0, offset) + text.slice(offset + 1);
        document.version++;
        const incremental = parser.getDocumentTreeSnapshot(document);
        check('edit uses the incremental path', original.generation, incremental.change?.fromGeneration);
        check('edit changes the tree from clean to erroneous', [false, true],
            [incremental.change?.oldHasError, incremental.change?.newHasError]);
        check('edit offsets remain UTF-16 document offsets', [offset, start],
            [incremental.change?.edits[0].startIndex,
                incremental.change && {
                    line: incremental.change.edits[0].startPosition.row,
                    character: incremental.change.edits[0].startPosition.column,
                }]);
        const full = parser.parseGapCode(text);
        const errors = new treeSitter.Query(parser.getGapLanguage(), '(ERROR) @error (MISSING) @missing');
        try {
            check('incremental and full trees agree', full.rootNode.toString(), incremental.tree.rootNode.toString());
            const positions = tree => errors.captures(tree.rootNode)
                .map(({ node }) => [node.type, node.startIndex, node.endIndex]);
            check('broken document has a parser error to compare', true, positions(full).length > 0);
            check('incremental and full error positions agree',
                positions(full), positions(incremental.tree));
        } finally {
            errors.delete();
            full.delete();
        }

        section('3. Null parse results reset the parser and allow a retry');
        const fullResets = withNullParse(() => {
            assert.throws(() => parser.parseGapCode('x := 1;'), { message: Messages.parser.parseFailed });
        });
        check('failed full parse resets the shared parser', 1, fullResets);

        parser.onDocumentChanged(uri, [{
            rangeOffset: offset, rangeLength: 0, range: { start, end: start }, text: ')',
        }]);
        text = text.slice(0, offset) + ')' + text.slice(offset);
        document.version++;
        const incrementalResets = withNullParse(() => {
            assert.throws(() => parser.getDocumentTreeSnapshot(document), { message: Messages.parser.parseFailed });
        });
        check('failed incremental parse resets the shared parser', 1, incrementalResets);
        const retry = parser.getDocumentTreeSnapshot(document);
        check('retry discards the failed cached tree', null, retry.change);
        check('retry parses the current document cleanly', [false, text.length],
            [retry.tree.rootNode.hasError, retry.tree.rootNode.endIndex]);
        summary();
    } finally {
        parser.disposeAll();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
