'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Parser, Query } = require('web-tree-sitter');
const { installMock, vscodeMock: vscode } = require('./mock-vscode');
installMock();
const parser = require('../../../out/language/parser/gapParser');
const { GAPSemanticTokensProvider } = require('../../../out/editor/highlight/semanticTokensProvider');
const { SEMANTIC_CONTENT_LIMIT } = require('../../../out/limits');
const root = path.resolve(__dirname, '../../..');
const query = name => path.join(root, 'queries', name);
const token = { isCancellationRequested: false };
const positionAt = (text, offset) => {
    const lines = text.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
};
const normalized = tokens => tokens.map(({ range, type, modifiers }) =>
    [range.start.line, range.start.character, range.end.character - range.start.character, type, modifiers]);

async function main() {
    await parser.initGapParser({ extensionUri: vscode.Uri.file(root) });
    const provider = new GAPSemanticTokensProvider(query('highlights.scm'), query('locals.scm'),
        query('highlights.global.scm'), { globalIndexMode: 'enabled' });
    let text = fs.readFileSync(path.join(root, 'test/highlightCases/mini.g'), 'utf8');
    const document = { uri: vscode.Uri.file(path.join(root, 'viewport.g')), version: 1, getText: () => text };
    const realMatches = Query.prototype.matches;
    let completionQueries = 0;
    Query.prototype.matches = function (...args) {
        if (this.captureNames.some(name => name.startsWith('completion.'))) completionQueries++;
        return realMatches.apply(this, args);
    };
    async function compare() {
        const all = provider.queryEntries(text).filter(entry => entry.type !== null);
        for (let line = 0; line < text.split('\n').length; line += 7) {
            const range = new vscode.Range(line, 0, line + 7, 0);
            const expected = all.filter(entry => entry.line >= line && entry.line < line + 7)
                .map(entry => [entry.line, entry.col, entry.text.length, entry.type, entry.modifiers]);
            assert.deepEqual(normalized(await provider.provideDocumentRangeSemanticTokens(document, range, token)), expected);
        }
    }
    try {
        await compare();
        const originalParse = Parser.prototype.parse;
        const originalMatches = Query.prototype.matches;
        let parses = 0;
        let fullQueries = 0;
        Parser.prototype.parse = function (...args) { parses++; return originalParse.apply(this, args); };
        Query.prototype.matches = function (node, options) {
            if (!options?.startPosition) fullQueries++;
            return originalMatches.call(this, node, options);
        };
        try {
            for (let line = 0; line < 25; line++) {
                await provider.provideDocumentRangeSemanticTokens(document, new vscode.Range(line, 0, line + 5, 0), token);
            }
            assert.equal(parses, 0, 'scrolling must reuse the parsed document');
            assert.equal(fullQueries, 0, 'scrolling must reuse the global index');
        } finally {
            Parser.prototype.parse = originalParse;
            Query.prototype.matches = originalMatches;
        }
        for (const inserted of ['s := "中文😀";\r\n', 'broken := ;\n', '# comment\n']) {
            const start = positionAt(text, 0);
            parser.onDocumentChanged(document.uri, [{ rangeOffset: 0, rangeLength: 0, range: { start, end: start }, text: inserted }]);
            text = inserted + text;
            document.version++;
            await compare();
        }
        text = Array.from({ length: 50 }, (_, index) =>
            `f${index} := function(p) local inner; inner := function(q) return p + q; end; return inner(p); end;`,
        ).join('\n');
        document.version++;
        await compare();
        for (const [before, after] of [
            ['function(q) return p + q; end', 'q -> p + q'],
            ['q -> p + q', 'atomic function(readonly q) return p + q; end'],
        ]) {
            const offset = text.indexOf(before);
            assert(offset >= 0);
            const start = positionAt(text, offset);
            const end = positionAt(text, offset + before.length);
            parser.onDocumentChanged(document.uri, [{
                rangeOffset: offset, rangeLength: before.length, range: { start, end }, text: after,
            }]);
            text = text.slice(0, offset) + after + text.slice(offset + before.length);
            document.version++;
            const matches = Query.prototype.matches;
            let rootQueries = 0;
            let partialQueries = 0;
            Query.prototype.matches = function (node, options) {
                if (!options?.startPosition) {
                    if (node.type === 'source_file') rootQueries++;
                    else partialQueries++;
                }
                return matches.call(this, node, options);
            };
            try {
                await provider.provideDocumentRangeSemanticTokens(document, new vscode.Range(0, 0, 8, 0), token);
                assert.equal(rootQueries, 0, 'a small valid edit must not fall back to a full global query');
                assert(partialQueries > 0, 'changed scopes must use incremental top-level queries');
            } finally { Query.prototype.matches = matches; }
            await compare();
        }
        assert.equal(await provider.provideDocumentRangeSemanticTokens(document, new vscode.Range(0, 0, 2, 0),
            { isCancellationRequested: true }), null);
        text = '#' + 'x'.repeat(SEMANTIC_CONTENT_LIMIT - 1);
        document.version++;
        assert.notEqual(await provider.provideDocumentRangeSemanticTokens(document, new vscode.Range(0, 0, 0, 10), token), null);
        text += 'x';
        document.version++;
        assert.equal(await provider.provideDocumentRangeSemanticTokens(document, new vscode.Range(0, 0, 0, 10), token), null);
        assert.equal(completionQueries, 0, 'highlighting must not trigger a separate binding-facts scan');
        provider.onDocumentClosed(document.uri);
        parser.onDocumentClosed(document.uri);
        console.log('Viewport tokens, incremental edits, cache reuse, cancellation and content limits passed.');
    } finally {
        Query.prototype.matches = realMatches;
        provider.dispose();
        parser.disposeAll();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
