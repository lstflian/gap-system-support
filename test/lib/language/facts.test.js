'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Query } = require('web-tree-sitter');
const { installMock, vscodeMock: vscode } = require('../highlight/mock-vscode');
installMock();
const parser = require('../../../out/language/parser/gapParser');
const { BindingAnalysis } = require('../../../out/language/analysis/bindings');
const { GAPScopedCompletions } = require('../../../out/language/analysis/scoped');
const { GAPReadCompletions } = require('../../../out/language/analysis/readCompletions');
const { GAPDefinitionResolver } = require('../../../out/language/analysis/definitionResolver');
const { collectSymbolDefinitions, collectSymbolOccurrences } = require('../../../out/language/analysis/symbols');
const { GLOBAL_SCOPE, createScopeEntries, addScopeDefinition, findPrecedingDefinition } =
    require('../../../out/language/analysis/scopes');
const root = path.resolve(__dirname, '../../..');
const query = path.join(root, 'queries', 'completion.scm');
const positionAt = (code, offset) => {
    const lines = code.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
};
function document(code, name = 'facts.g') {
    return {
        uri: vscode.Uri.file(path.join(root, name)),
        version: 1, isUntitled: false, code,
        getText() { return this.code; },
        offsetAt(position) {
            return this.code.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0)
                + position.character;
        },
    };
}

async function main() {
    await parser.initGapParser({ extensionUri: vscode.Uri.file(root) });
    const analysis = new BindingAnalysis(query);
    const completion = new GAPScopedCompletions(query, analysis);
    const resolver = new GAPDefinitionResolver(query, { openDocuments: () => [], workspaceRoot: () => null }, analysis);
    const source = [
        'outer := 1;', 'f := function(p, rest...)', 'local x, inner;',
        'x := p;', 'outer := x;', 'for i in [1..3] do x := i; od;',
        'inner := function(q) local y; y := q; return y + x; end;',
        'return inner(x);', 'end;', 'r := rec(field := rec(nested := 1));',
        'r.field.nested := 2;', 'r!.value := 3;', 'Read("library.g");',
        's := "\u4e2d\u6587\u{1f600}"; z := 1;', 'f(outer);',
    ].join('\r\n');
    const doc = document(source);
    const originalMatches = Query.prototype.matches;
    let queries = 0;
    Query.prototype.matches = function (...args) { queries++; return originalMatches.apply(this, args); };
    try {
        const tree = parser.getDocumentTree(doc);
        const facts = analysis.getDocument(doc, tree);
        const unprojected = structuredClone(facts);
        const cursor = positionAt(source, source.indexOf('return inner'));
        const items = completion.getItems(doc, cursor);
        assert(items.some(item => item.name === 'p' && item.kind === 'parameter'));
        assert(items.some(item => item.name === 'inner' && item.kind === 'function'));
        assert(!items.some(item => item.name === 'q' || item.name === 'y'));
        assert.equal(resolver.resolveDefinition(doc, cursor, 'x').symbolKind, 'variable');
        completion.getReadCalls(doc, positionAt(source, source.length));
        assert.equal(queries, 1, 'completion and navigation must share one completion query per cached snapshot');
        assert.equal(analysis.getDocument(doc, tree), facts);
        assert.deepEqual(facts, unprojected, 'feature projections must not mutate shared facts');
        const outerScope = source.indexOf('function(p');
        assert(facts.bindings.some(binding => binding.name === 'p' && binding.role === 'parameter' && binding.scope === outerScope));
        assert(facts.bindings.some(binding => binding.name === 'x' && binding.role === 'local'));
        assert(facts.bindings.some(binding => binding.name === 'x' && binding.role === 'assignment'));
        assert(facts.bindings.some(binding => binding.name === 'i' && binding.role === 'loop'));
        assert(!facts.bindings.some(binding => binding.name === 'field' || binding.name === 'nested'));
        assert(facts.bindings.some(binding => binding.name === 'outer' && binding.role === 'assignment' && binding.scope === outerScope),
            'an assignment occurrence is not reclassified as a local declaration');
        assert.equal(facts.bindings.find(binding => binding.name === 'f').headerText, 'function(p, rest...)');
        assert.deepEqual(facts.readCalls.map(call => call.path), ['library.g']);
        for (const binding of facts.bindings) {
            assert.equal(source.slice(binding.start, binding.end), binding.name);
            assert.deepEqual(binding.position, positionAt(source, binding.start));
            assert(!('mapping' in binding) && !('captureName' in binding));
        }

        const symbols = collectSymbolDefinitions(tree.rootNode);
        assert.deepEqual(symbols.members.map(member => member.name), ['r.field', 'r.field.nested', 'r.field.nested', 'r!.value']);
        assert(symbols.members.every(member => member.role === 'member' && member.scope === GLOBAL_SCOPE));
        const occurrences = collectSymbolOccurrences(tree.rootNode);
        assert(occurrences.has('r.field.nested'));
        assert(!occurrences.has('library.g'), 'ordinary string contents are not symbol references');
        const detached = structuredClone({ facts, symbols, occurrences });
        assert.deepEqual(detached.facts, facts, 'shared facts contain source values, not live parser nodes');

        completion.dispose();
        resolver.dispose();
        assert.equal(analysis.getDocument(doc, tree), facts, 'consumers do not dispose an injected shared analysis');
        analysis.onDocumentClosed(doc.uri);
        const rebuilt = analysis.getDocument(doc, tree);
        assert.notEqual(rebuilt, facts);
        assert.equal(queries, 2, 'closing a document clears its shared facts');
        doc.version++;
        doc.code = source.replace('local x, inner;', 'local changed, inner;');
        const updated = analysis.getDocument(doc, parser.getDocumentTree(doc));
        assert(updated.bindings.some(binding => binding.name === 'changed' && binding.role === 'local'));
        assert(!updated.bindings.some(binding => binding.name === 'x' && binding.role === 'local'));
        assert.equal(queries, 3);
        parser.onDocumentClosed(doc.uri);
        const reparsed = analysis.getDocument(doc, parser.getDocumentTree(doc));
        assert.notEqual(reparsed, updated, 'a replacement tree invalidates facts even at the same document version');
        assert.equal(queries, 4);
        assert.deepEqual(detached.facts, facts, 'older facts remain usable after the parser deletes its tree');

        const variants = document([
            'f := function(a,a) local x,x; return a; end;',
            'g := atomic function(readonly p, readwrite q, rest...) return p; end;',
            'h := {x,y} -> x + y;', 'k := x -> x;',
        ].join('\n'), 'variants.g');
        const variantFacts = analysis.getDocument(variants, parser.getDocumentTree(variants));
        assert.equal(variantFacts.bindings.filter(binding => binding.name === 'a' && binding.role === 'parameter').length, 2);
        assert.equal(variantFacts.bindings.filter(binding => binding.name === 'x' && binding.role === 'local').length, 2);
        for (const name of ['p', 'q', 'rest']) {
            assert(variantFacts.bindings.some(binding => binding.name === name && binding.role === 'parameter'));
        }
        assert.equal(variantFacts.scopes.length, 5, 'functions, atomic functions and lambdas all introduce scopes');

        const broken = document('bad := function(x) local y; y := ; return x; end;\ngood := 1;\n', 'broken.g');
        const brokenTree = parser.getDocumentTree(broken);
        assert(brokenTree.rootNode.hasError);
        const brokenFacts = analysis.getDocument(broken, brokenTree);
        assert(brokenFacts.bindings.some(binding => binding.name === 'good'));
        assert(brokenFacts.bindings.some(binding => binding.name === 'y' && binding.role === 'assignment'),
            'a missing RHS does not make the assignment name an ERROR descendant');
        const recovered = document('if function(a) local x; x := 1; end; fi;\ngood := 1;', 'recovered.g');
        const recoveredTree = parser.getDocumentTree(recovered);
        assert(recoveredTree.rootNode.hasError);
        const recoveredFacts = analysis.getDocument(recovered, recoveredTree);
        assert.deepEqual(recoveredFacts.bindings.map(binding => binding.name), ['good'],
            'captures inside an ERROR ancestor must be excluded');
        assert.equal(recoveredFacts.scopes.length, 1);

        const api = document([
            'DeclareGlobalFunction("Example");',
            'InstallGlobalFunction(Example, function() return 1; end);',
            'DeclareOperationKernel("Op", []);',
            'InstallMethodWithCache(Op, [], function() return 1; end);',
            'BindConstant("Constant", 1);',
            'DeclareNotASymbol("Ignored");',
        ].join('\n'), 'api.g');
        const apiTree = parser.getDocumentTree(api);
        const apiFacts = collectSymbolDefinitions(apiTree.rootNode);
        assert.deepEqual(apiFacts.declarations.map(value => [value.name, value.kind, value.role]), [
            ['Example', 'global-function', 'declaration'],
            ['Example', 'global-function', 'implementation'],
            ['Op', 'global', 'declaration'],
            ['Op', 'global', 'implementation'],
            ['Constant', 'global', 'implementation'],
        ]);
        const apiOccurrences = collectSymbolOccurrences(apiTree.rootNode);
        for (const name of ['Example', 'Op', 'Constant']) assert(apiOccurrences.has(name));
        assert(!apiOccurrences.has('Ignored'));

        const library = document([
            'publicFn := function(x) local hidden; hidden := y -> y; return hidden(x); end;',
            'publicFn := function() return 2; end;',
            'other := z -> z;', 'notFn := 1;',
            'Read("test/highlightCases/keywords.g");',
        ].join('\n'), path.join('test', 'highlightCases', 'mini.g'));
        const nested = document('tail := function() return true; end;\nRead("test/highlightCases/mini.g");',
            path.join('test', 'highlightCases', 'keywords.g'));
        const readHost = { openDocuments: () => [library, nested], workspaceRoot: () => root };
        const readCalls = [{ end: 0, path: 'test/highlightCases/mini.g' }];
        const read = new GAPReadCompletions(query, readHost, analysis);
        try {
            const before = queries;
            assert.deepEqual(read.getFunctionNames(doc, readCalls), ['publicFn', 'other', 'tail'],
                'Read chains retain top-level filtering, ordering, deduplication and cycle handling');
            assert.equal(queries, before + 2);
            assert.deepEqual(read.getFunctionNames(doc, readCalls), ['publicFn', 'other', 'tail']);
            assert.equal(queries, before + 2, 'Read chains reuse their existing file cache');
            library.code = library.code.replace('other :=', 'updated :=');
            library.version++;
            assert.deepEqual(read.getFunctionNames(doc, readCalls), ['publicFn', 'updated', 'tail']);
            assert.equal(queries, before + 3, 'an edited open Read file invalidates its cached projection');
        } finally { read.dispose(); }

        const scopes = createScopeEntries([{ start: 5, end: 30 }, { start: 10, end: 20 }]);
        const global = { start: 1, end: 2, role: 'assignment' };
        const local = { start: 11, end: 12, role: 'local' };
        addScopeDefinition(scopes[0], 'value', global);
        addScopeDefinition(scopes[2], 'value', local);
        assert.equal(findPrecedingDefinition('value', 12, scopes), global, 'definition end visibility remains strict');
        assert.equal(findPrecedingDefinition('value', 13, scopes), local);
        assert.equal(findPrecedingDefinition('value', 20, scopes), global, 'scope end is exclusive');

        const ownCompletion = new GAPScopedCompletions(query);
        const ownResolver = new GAPDefinitionResolver(query, { openDocuments: () => [], workspaceRoot: () => null });
        const ownRead = new GAPReadCompletions(query, readHost);
        const originalDelete = Query.prototype.delete;
        let deletedQueries = 0;
        Query.prototype.delete = function () { deletedQueries++; return originalDelete.call(this); };
        try {
            ownCompletion.getItems(api, positionAt(api.code, api.code.length));
            ownResolver.resolveDefinition(api, positionAt(api.code, api.code.length), 'Example');
            ownRead.getFunctionNames(doc, readCalls);
            ownCompletion.dispose();
            ownResolver.dispose();
            ownRead.dispose();
            assert.equal(deletedQueries, 3, 'standalone consumers dispose their own analysis queries');
            ownCompletion.dispose();
            ownResolver.dispose();
            ownRead.dispose();
            assert.equal(deletedQueries, 3, 'owned analysis disposal is idempotent');
        } finally {
            ownCompletion.dispose();
            ownResolver.dispose();
            ownRead.dispose();
            Query.prototype.delete = originalDelete;
        }
        console.log('Shared binding query, declaration roles, scopes, symbol occurrences, UTF-16 positions and cache lifetime passed.');
    } finally {
        Query.prototype.matches = originalMatches;
        resolver.dispose();
        completion.dispose();
        analysis.dispose();
        parser.disposeAll();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
