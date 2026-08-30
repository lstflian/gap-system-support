/**
 * Hover tests: the compiled resolver and the provider run under a mocked
 * vscode API, the Read chain uses real temporary .g files.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');

// The hover code reads workspace folders and open documents.
// Extend the shared mock here without touching the shared mock file.
const workspaceState = {
    folderPath: null,
    textDocuments: [],
};
vscodeMock.workspace = {
    getWorkspaceFolder: () => (
        workspaceState.folderPath ? { uri: { fsPath: workspaceState.folderPath } } : undefined
    ),
    get textDocuments() {
        return workspaceState.textDocuments;
    },
    getConfiguration: () => ({ get: () => undefined }),
};

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}
vscodeMock.Position = Position;

class Range {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}
vscodeMock.Range = Range;

class MarkdownString {
    constructor(value) {
        this.value = value || '';
        this.isTrusted = undefined;
    }
    appendText(text) {
        // Mirror the real markdown escaping closely enough for the assertions here.
        this.value += text.replace(/[\\`*_{}[\]()#+.!-]/g, m => '\\' + m);
        return this;
    }
    appendMarkdown(md) {
        this.value += md;
        return this;
    }
    appendCodeblock(code, lang) {
        const runs = code.match(/`{3,}/g) || [];
        const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
        const fence = '`'.repeat(Math.max(3, longest + 1));
        this.value += `${fence}${lang || ''}\n${code}\n${fence}`;
        return this;
    }
}
vscodeMock.MarkdownString = MarkdownString;

class Hover {
    constructor(contents, range) {
        this.contents = contents;
        this.range = range;
    }
}
vscodeMock.Hover = Hover;

class CancellationTokenStub {
    constructor() {
        this.isCancellationRequested = false;
    }
}

installMock();

const { initGapParser } = require('../../../out/parser/gapParser');
const { GAPDefinitionResolver } = require('../../../out/hover/definitionResolver');
const { GAPHoverProvider } = require('../../../out/hover/hoverProvider');

const ROOT = path.join(__dirname, '..', '..', '..');
const QUERY_PATH = path.join(ROOT, 'queries', 'completion.scm');

/** A minimal TextDocument over a string. */
function makeDocument(fileName, text, workspacePath, isUntitled = false) {
    const lines = text.split(/\r?\n/);
    return {
        uri: { toString: () => `file:///hover-test/${fileName}`, fsPath: path.join(workspacePath || os.tmpdir(), fileName) },
        fileName,
        version: 1,
        isUntitled,
        getText: () => text,
        languageId: 'gap',
        offsetAt: p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character,
        lineAt: n => lines[n] || '',
    };
}

/** Return the (line, character) of the n-th (0-based) occurrence of `needle`. */
function positionOf(text, needle, occurrence = 0) {
    let from = 0;
    for (let i = 0; i <= occurrence; i++) {
        const found = text.indexOf(needle, from);
        if (found < 0) throw new Error(`needle not found: ${needle}`);
        if (i === occurrence) {
            const before = text.slice(0, found);
            const line = before.split(/\r?\n/).length - 1;
            const character = found - (before.lastIndexOf('\n') + 1);
            return { line, character };
        }
        from = found + 1;
    }
    throw new Error('unreachable');
}

/** Return the provider hover over `needle`, or undefined. */
function hoverAt(provider, doc, needle, occurrence = 0) {
    return provider.provideHover(
        doc,
        positionOf(doc.getText(), needle, occurrence),
        new CancellationTokenStub(),
    );
}

/** Return the hover text contents, or undefined. */
function textOf(hover) {
    return hover && hover.contents ? hover.contents.value : undefined;
}

/** Return the term encoded in the command link, or null. */
function linkTerm(md) {
    const m = /command:gap\.searchHelpTerm\?([^)]*)\)/.exec(md.value);
    return m ? JSON.parse(decodeURIComponent(m[1]))[0] : null;
}

/** Return whether a hover text is the unknown-function fallback. */
function isFallback(text) {
    return text !== undefined && text.includes('No function information');
}

/** Resolve through the resolver entry point with a plain document. */
function resolveWith(resolver, code, name, needle) {
    return resolver.resolveDefinition(
        makeDocument('comments.g', code, null),
        positionOf(code, needle),
        name,
    );
}

async function main() {
    await initGapParser({ extensionUri: { fsPath: ROOT } });

    const provider = new GAPHoverProvider(QUERY_PATH);

    section('1. Node classification: only function names trigger a hover');
    {
        const code = [
            'myfn := function(x)',
            '  return x;',
            'end;',
            'myfn(1);',
            'y := 3;',
            'f2 := { x -> x + 1 };',
        ].join('\n');
        const doc = makeDocument('classify.g', code, null);
        check('definition identifier hovers', true, (await hoverAt(provider, doc, 'myfn :=')) !== undefined);
        check('call identifier hovers', true, (await hoverAt(provider, doc, 'myfn(1)')) !== undefined);
        check('lambda definition hovers', true, (await hoverAt(provider, doc, 'f2 :=')) !== undefined);
        check('variable assignment does not hover', true, (await hoverAt(provider, doc, 'y :=')) === undefined);
        check('keyword does not hover', true, (await hoverAt(provider, doc, 'return')) === undefined);
    }

    section('2. Fallback for unknown names');

    {
        const doc = makeDocument('fallback.g', 'lonelyfn();\n', null);
        const t = textOf(await hoverAt(provider, doc, 'lonelyfn('));
        check('unknown function gets the fallback hover', true,
            t !== undefined && t.includes('No function information'));
    }

    section('4. Comment rules');

    {
        const resolver = new GAPDefinitionResolver(QUERY_PATH);
        let r;

        // A blank line between the comments and the definition stops collection.
        r = resolveWith(resolver, '## lost\n\nb := function()\nend;\nb();', 'b', 'b();');
        check('blank line stops comments', [], r.commentLines);

        // A single # comment line neither counts nor continues the block.
        r = resolveWith(resolver, '# one\n## kept\nc := function()\nend;\nc();', 'c', 'c();');
        check('single hash stops collection', ['kept'], r.commentLines);

        // Consecutive ## lines are all collected without a bound.
        r = resolveWith(resolver, '## 1\n## 2\n## 3\nd := function()\nend;\nd();', 'd', 'd();');
        check('all consecutive lines collected', ['1', '2', '3'], r.commentLines);

        // Exactly one space after the hashes is stripped.
        r = resolveWith(resolver, '##    indent kept\ne := function()\nend;\ne();', 'e', 'e();');
        check('only one space stripped', ['   indent kept'], r.commentLines);

        // A comment without a space after the hashes is still collected.
        r = resolveWith(resolver, '##nospace\nf := function()\nend;\nf();', 'f', 'f();');
        check('no space after hash', ['nospace'], r.commentLines);

        // A definition without comments yields an empty list.
        r = resolveWith(resolver, 'g := function(x)\n  return x;\nend;\ng(1);', 'g', 'g(1);');
        check('no comments yields empty list', [], r.commentLines);
        check('definition line trimmed', 'g := function(x)', r.definitionLine);

        // An indented definition line is copied verbatim, whitespace trimmed only.
        r = resolveWith(resolver, ' indentdef := function(y)\nend;\nindentdef(2);', 'indentdef', 'indentdef(2);');
        check('indented definition line trimmed', 'indentdef := function(y)', r.definitionLine);

        // The definition row and the file path are exposed.
        r = resolveWith(resolver, '## c\nk := function()\nend;\nk();', 'k', 'k();');
        check('row is the definition line', 1, r.row);
        check('file path present', true, typeof r.filePath === 'string' && r.filePath.length > 0);
    }

    section('4b. Definition line: syntax-tree header slice');    {
        const resolver = new GAPDefinitionResolver(QUERY_PATH);
        let r;

        // An inline comment after the parameter list is dropped.
        r = resolveWith(resolver, 'a := function(x) # some comment\nend;\na(1);', 'a', 'a(1);');
        check('inline comment dropped', 'a := function(x)', r.definitionLine);

        // A single-line body is dropped.
        r = resolveWith(resolver, 'b := function(x) return x; end;\nb(1);', 'b', 'b(1);');
        check('single-line body dropped', 'b := function(x)', r.definitionLine);

        // An atomic function keeps the atomic keyword in the header.
        r = resolveWith(resolver, 'c := atomic function(x)\nend;\nc(1);', 'c', 'c(1);');
        check('atomic function header', 'c := atomic function(x)', r.definitionLine);

        // A lambda has no parameter list, so the raw line is kept.
        r = resolveWith(resolver, 'd := x -> x + 1;\nd(1);', 'd', 'd(1);');
        check('lambda raw line', 'd := x -> x + 1;', r.definitionLine);

        // A multiline parameter list is flattened onto one line.
        r = resolveWith(resolver, 'e := function(x,\n     y)\n  return x;\nend;\ne(1);', 'e', 'e(1);');
        check('multiline parameters flattened', 'e := function(x, y)', r.definitionLine);
    }

    section('5. Redefinition: the definition above the hover wins');

    {
        const code = [
            '## first version',
            'h := function()',
            '  return 1;',
            'end;',
            '## second version',
            'h := function()',
            '  return 2;',
            'end;',
            'h();',
        ].join('\n');
        const doc = makeDocument('redef.g', code, null);
        const hover = await hoverAt(provider, doc, 'h();');
        check('later definition shown', true,
            textOf(hover).includes('second version') && !textOf(hover).includes('first version'));

        // Hover directly on the first definition identifier shows that one.
        const hoverFirst = await hoverAt(provider, doc, 'h :=', 0);
        check('hover on first definition shows it', true, textOf(hoverFirst).includes('first version'));
    }

    section('5b. Scoped visibility matches scoped completion');

    {
        const code = [
            '## global helper',
            'helper := function()',
            '  return 1;',
            'end;',
            '',
            'outer := function()',
            '  ## outer-local helper',
            '  helper := function()',
            '    return 2;',
            '  end;',
            '  inner := function()',
            '    ## innermost helper',
            '    helper := function()',
            '      return 3;',
            '    end;',
            '    helper();',
            '  end;',
            '  inner();',
            'end;',
            '',
            'outer();',
            'helper();',
        ].join('\n');
        const doc = makeDocument('scopes.g', code, null);

        // Inside inner(), the innermost definition wins by shadowing.
        const hoverInner = await hoverAt(provider, doc, 'helper();');
        check('innermost scope wins', true,
            textOf(hoverInner).includes('innermost helper')
            && !textOf(hoverInner).includes('outer-local helper')
            && !textOf(hoverInner).includes('global helper'));

        // At the global level, definitions nested inside functions are invisible.
        const hoverGlobal = await hoverAt(provider, doc, 'helper();', 1);
        check('sibling scope definitions not visible', true,
            textOf(hoverGlobal).includes('global helper')
            && !textOf(hoverGlobal).includes('outer-local helper')
            && !textOf(hoverGlobal).includes('innermost helper'));

        // Directly inside outer(), the local definition shadows the global one.
        const code2 = [
            '## global helper',
            'helper := function()',
            '  return 1;',
            'end;',
            '',
            'outer := function()',
            '  ## outer-local helper',
            '  helper := function()',
            '    return 2;',
            '  end;',
            '  helper();',
            'end;',
        ].join('\n');
        const doc2 = makeDocument('scopes2.g', code2, null);
        const hoverOuter = await hoverAt(provider, doc2, 'helper();');
        check('own scope definition shadows global', true,
            textOf(hoverOuter).includes('outer-local helper')
            && !textOf(hoverOuter).includes('global helper'));

        // A definition below the hover position, buried inside a nested invisible scope, is not picked.
        // No global definition exists, so the fallback text is shown.
        const code3 = [
            'outer3 := function()',
            '  defBelow := function()',
            '    helper := function()',
            '      return 9;',
            '    end;',
            '  end;',
            '  helper();',
            'end;',
        ].join('\n');
        const doc3 = makeDocument('scopes3.g', code3, null);
        const hoverBelow = await hoverAt(provider, doc3, 'helper();');
        check('definition below hover in hidden scope not shown', true,
            isFallback(textOf(hoverBelow)));
    }

    section('6. Read chain resolution');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-hover-'));
    try {
        workspaceState.folderPath = tmp;

        // lib.g defines the same name twice, the later one wins.
        fs.writeFileSync(path.join(tmp, 'lib.g'), [
            '## lib old',
            'readfn := function()',
            '  return 1;',
            'end;',
            '## lib new',
            'readfn := function()',
            '  return 2;',
            'end;',
        ].join('\n'));

        const code = 'Read("lib.g");\nreadfn();\n';
        const doc = makeDocument('main.g', code, tmp);
        const hover = await hoverAt(provider, doc, 'readfn(');
        check('definition found through Read', true, textOf(hover).includes('lib new'));
        check('older lib definition not shown', true, !textOf(hover).includes('lib old'));
        check('read definition shows the lib path', true, textOf(hover).includes(`Defined in [${path.join(tmp, 'lib.g')}](command:gap.goToDefinition?`));
        check('read definition path is the link', true,
            textOf(hover).includes('[Go to Definition]') === false
            && textOf(hover).includes(`[${path.join(tmp, 'lib.g')}](command:gap.goToDefinition?`));

        // A local definition placed after the Read shadows the Read one.
        const code2 = 'Read("lib.g");\n## local wins\nreadfn := function()\nend;\nreadfn();\n';
        const doc2 = makeDocument('main2.g', code2, tmp);
        check('local definition after Read wins', true,
            textOf(await hoverAt(provider, doc2, 'readfn(')).includes('local wins'));

        // A Read below the hover does not count.
        const code3 = 'readfn();\nRead("lib.g");\n';
        const doc3 = makeDocument('main3.g', code3, tmp);
        check('Read below hover ignored (fallback)', true,
            isFallback(textOf(await hoverAt(provider, doc3, 'readfn('))));

        // A missing Read target is skipped silently.
        const code4 = 'Read("missing.g");\nreadfn();\n';
        const doc4 = makeDocument('main4.g', code4, tmp);
        check('missing Read target falls back', true,
            isFallback(textOf(await hoverAt(provider, doc4, 'readfn('))));

        // Backslash paths are rejected like in completions.
        const code5 = 'Read("sub\\\\dir.g");\nreadfn();\n';
        const doc5 = makeDocument('main5.g', code5, tmp);
        check('backslash Read skipped', true,
            isFallback(textOf(await hoverAt(provider, doc5, 'readfn('))));

        // Circular Reads must not hang.
        fs.writeFileSync(path.join(tmp, 'loop1.g'), 'Read("loop2.g");\nloopfn := function()\nend;\n');
        fs.writeFileSync(path.join(tmp, 'loop2.g'), 'Read("loop1.g");\n');
        const code6 = 'Read("loop1.g");\nloopfn();\n';
        const doc6 = makeDocument('main6.g', code6, tmp);
        check('circular Reads resolve without hanging', true,
            (await hoverAt(provider, doc6, 'loopfn(')) !== undefined);

        // Absolute path Reads are used directly.
        const abs = path.join(tmp, 'abs.g').split(path.sep).join('/');
        fs.writeFileSync(path.join(tmp, 'abs.g'), '## absolute\nabsfn := function()\nend;\n');
        const code7 = `Read("${abs}");\nabsfn();\n`;
        const doc7 = makeDocument('main7.g', code7, tmp);
        check('absolute Read path works', true,
            textOf(await hoverAt(provider, doc7, 'absfn(')).includes('absolute'));

        // A nested Read scans the inner file from its bottom.
        fs.writeFileSync(path.join(tmp, 'nested.g'), 'Read("lib.g");\n');
        const code8 = 'Read("nested.g");\nreadfn();\n';
        const doc8 = makeDocument('main8.g', code8, tmp);
        check('nested Read resolves to the lib definition', true,
            textOf(await hoverAt(provider, doc8, 'readfn(')).includes('lib new'));

        // Open documents are preferred over the disk content.
        // The file must exist on disk because relative Read resolution requires it.
        fs.writeFileSync(path.join(tmp, 'open.g'), '## disk stale\nopenfn := function()\nend;\n');
        const openDoc = makeDocument('open.g', '## open doc\nopenfn := function()\nend;\n', tmp);
        workspaceState.textDocuments.push(openDoc);
        const code9 = 'Read("open.g");\nopenfn();\n';
        const doc9 = makeDocument('main9.g', code9, tmp);
        check('open document content used for Read files', true,
            textOf(await hoverAt(provider, doc9, 'openfn(')).includes('open doc'));
        workspaceState.textDocuments.length = 0;
    } finally {
        workspaceState.folderPath = null;
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    section('7. GAP functions win over user defined ones');

    {
        // Load the real functions-all.json into the data manager memory.
        // The manager offers no setter in tests: swap the module export table.
        const dataManager = require('../../../out/completion/dataManager');
        const names = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'data', 'completionData', 'functions-all.json'), 'utf8'),
        ).names;
        const realGet = dataManager.getFunctionNames;
        dataManager.getFunctionNames = () => new Set(names);

        // A user defined function with the same name loses against the GAP one.
        const code = '## shadowed\nSize := function()\nend;\nSize();\n';
        const doc = makeDocument('system.g', code, null);
        const hover = await hoverAt(provider, doc, 'Size(');
        check('GAP function shows the title', true,
            textOf(hover).includes('**GAP function**'));
        check('GAP function shows the help link text', true,
            textOf(hover).includes('See more information in'));
        check('link targets the hovered name', 'Size', linkTerm(hover.contents));
        check('markdown trust limited to the term command',
            JSON.stringify(['gap.searchHelpTerm']), JSON.stringify(hover.contents.isTrusted.enabledCommands));

        dataManager.getFunctionNames = realGet;
    }

    section('8. Document model cache');

    {
        const resolver = new GAPDefinitionResolver(QUERY_PATH);
        const code = '## once\nk := function()\nend;\nk();\n';
        const doc = makeDocument('cache.g', code, null);
        const p = positionOf(code, 'k();');
        const r1 = resolver.resolveDefinition(doc, p, 'k');
        const r2 = resolver.resolveDefinition(doc, p, 'k');
        check('second call reuses the cached model', r1, r2);

        // A changed document version invalidates the cache.
        const code2 = code.replace('once', 'twice');
        const doc2 = { ...makeDocument('cache.g', code2, null), version: 2 };
        const r3 = resolver.resolveDefinition(doc2, p, 'k');
        check('changed version reparses', 'twice', r3.commentLines && r3.commentLines[0]);
    }

    summary();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
