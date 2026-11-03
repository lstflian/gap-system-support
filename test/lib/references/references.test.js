/**
 * Reference provider tests run under a mocked VS Code API.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');

const workspaceState = {
    folderPath: null,
    documents: [],
    findFilesCalls: 0,
};

vscodeMock.workspace = {
    getWorkspaceFolder: uri => (
        workspaceState.folderPath &&
        uri.fsPath.startsWith(workspaceState.folderPath)
            ? { uri: vscodeMock.Uri.file(workspaceState.folderPath) }
            : undefined
    ),
    findFiles: async () => {
        workspaceState.findFilesCalls++;
        return workspaceState.documents.map(document => document.uri);
    },
    openTextDocument: async uri => {
        const document = workspaceState.documents.find(item => item.uri.fsPath === uri.fsPath);
        if (!document) throw new Error(`Document not found: ${uri.fsPath}`);
        return document;
    },
    get textDocuments() {
        return workspaceState.documents;
    },
    getConfiguration: () => ({ get: () => undefined }),
};

class CancellationTokenStub {
    constructor(cancelled = false) {
        this.isCancellationRequested = cancelled;
    }
}

installMock();

const { initGapParser } = require('../../../out/language/parser/gapParser');
const { GAPReferenceProvider } = require('../../../out/editor/references/referenceProvider');

const ROOT = path.join(__dirname, '..', '..', '..');
const QUERY_PATH = path.join(ROOT, 'queries', 'completion.scm');

function makeDocument(fileName, text, workspacePath, isUntitled = false) {
    const lines = text.split(/\r?\n/);
    const fsPath = isUntitled ? '' : path.join(workspacePath || os.tmpdir(), fileName);
    const uri = isUntitled
        ? { fsPath: '', toString: () => 'untitled:Untitled-1' }
        : vscodeMock.Uri.file(fsPath);
    return {
        uri,
        fileName: fsPath || fileName,
        version: 1,
        isUntitled,
        languageId: 'gap',
        getText: () => text,
        offsetAt: position =>
            lines.slice(0, position.line).reduce((length, line) => length + line.length + 1, 0) +
            position.character,
        lineAt: line => lines[line] || '',
    };
}

function positionOf(text, needle, occurrence = 0) {
    let from = 0;
    for (let index = 0; index <= occurrence; index++) {
        const found = text.indexOf(needle, from);
        if (found < 0) throw new Error(`needle not found: ${needle}`);
        if (index === occurrence) {
            const before = text.slice(0, found);
            return {
                line: before.split(/\r?\n/).length - 1,
                character: found - (before.lastIndexOf('\n') + 1),
            };
        }
        from = found + 1;
    }
    throw new Error('unreachable');
}

async function referencesAt(
    provider,
    document,
    needle,
    occurrence = 0,
    includeDeclaration = true,
    token = new CancellationTokenStub(),
) {
    return provider.provideReferences(
        document,
        positionOf(document.getText(), needle, occurrence),
        { includeDeclaration },
        token,
    );
}

function linesOf(locations) {
    return locations.map(location => location.range.start.line);
}

function fileAndLineOf(locations) {
    return locations.map(location => `${path.basename(location.uri.fsPath)}:${location.range.start.line}`);
}

async function main() {
    await initGapParser({ extensionUri: { fsPath: ROOT } });
    const provider = new GAPReferenceProvider(QUERY_PATH);

    section('1. Same-file references');
    {
        const code = [
            'myfn := function(x)',
            '  return x;',
            'end;',
            'a := myfn(1);',
            'b := myfn(2);',
        ].join('\n');
        workspaceState.folderPath = os.tmpdir();
        const document = makeDocument('same-file.g', code, os.tmpdir());
        workspaceState.documents = [document];
        workspaceState.findFilesCalls = 0;

        check('definition omits itself and returns both usages', [3, 4],
            linesOf(await referencesAt(provider, document, 'myfn :=')));
        check('usage omits itself from the reference set', [0, 4],
            linesOf(await referencesAt(provider, document, 'myfn(1)')));
        check('declarations can be excluded', [4],
            linesOf(await referencesAt(provider, document, 'myfn(1)', 0, false)));
        check('workspace file discovery is reused', 1, workspaceState.findFilesCalls);
        check('symbol index is reused on repeated requests', [3, 4],
            linesOf(await referencesAt(provider, document, 'myfn :=')));
        check('repeated request does not rediscover files', 1, workspaceState.findFilesCalls);
        workspaceState.folderPath = null;
    }

    section('2. Lexical shadowing');
    {
        const code = [
            'value := 1;',
            'worker := function(value)',
            '  return value;',
            'end;',
            'first := value;',
            'second := value;',
        ].join('\n');
        const document = makeDocument('shadow.g', code);
        workspaceState.documents = [document];

        check('global references exclude the origin and shadowed parameter', [0, 5],
            linesOf(await referencesAt(provider, document, 'value;', 1)));
        check('parameter references stay inside their function', [2],
            linesOf(await referencesAt(provider, document, 'value)', 0)));

        const localCode = [
            'worker := function()',
            '  local item;',
            '  item := 1;',
            '  return item;',
            'end;',
            'item := 2;',
            'item;',
        ].join('\n');
        const localDocument = makeDocument('local-assignment.g', localCode);
        workspaceState.documents = [localDocument];
        check('local assignments stay inside their lexical scope', [3],
            linesOf(await referencesAt(provider, localDocument, 'item :=', 0)));
    }

    section('3. Qualified record and component paths');
    {
        const code = [
            'A := rec(Print := 1);',
            'B := rec(Print := 2);',
            'A.Print;',
            'B.Print;',
            'internal := rec();',
            'internal!.cache := 1;',
            'copy := internal!.cache;',
        ].join('\n');
        const document = makeDocument('qualified.g', code);
        workspaceState.documents = [document];

        check('record field definition resolves its qualified references', [2],
            linesOf(await referencesAt(provider, document, 'Print :=', 0)));
        check('A.Print does not include its origin or B.Print', [0],
            linesOf(await referencesAt(provider, document, 'Print;', 0)));
        check('B.Print does not include its origin or A.Print', [1],
            linesOf(await referencesAt(provider, document, 'Print;', 1)));
        check('component selectors preserve the complete path', [5],
            linesOf(await referencesAt(provider, document, 'cache;')));
    }

    section('4. Cross-file dotted references');
    {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-references-'));
        try {
            const internalText = [
                'MAGNETIC_INTERNAL.RepresentationByGenerators := function(x)',
                '  return x;',
                'end;',
            ].join('\n');
            const apiText = [
                'result := MAGNETIC_INTERNAL.RepresentationByGenerators(1);',
                'other := MAGNETIC_INTERNAL.RepresentationByGenerators(2);',
            ].join('\n');
            fs.writeFileSync(path.join(tmp, 'internal.g'), internalText);
            fs.writeFileSync(path.join(tmp, 'api.g'), apiText);

            const internalDocument = makeDocument('internal.g', internalText, tmp);
            const apiDocument = makeDocument('api.g', apiText, tmp);
            workspaceState.folderPath = tmp;
            workspaceState.documents = [internalDocument, apiDocument];

            check('workspace search returns the definition and both usages',
                ['api.g:1', 'internal.g:0'],
                fileAndLineOf(await referencesAt(
                    provider,
                    apiDocument,
                    'RepresentationByGenerators',
                )));
        } finally {
            workspaceState.folderPath = null;
            workspaceState.documents = [];
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    section('5. Declaration APIs and syntax exclusions');
    {
        const code = [
            'DeclareGlobalFunction("declaredFn");',
            'InstallGlobalFunction(declaredFn, function(x) return x; end);',
            '# declaredFn in a comment',
            'message := "declaredFn";',
            'declaredFn(1);',
        ].join('\n');
        const document = makeDocument('declaration.g', code);
        workspaceState.documents = [document];

        check('declaration and implementation names count as declarations', [0, 1],
            linesOf(await referencesAt(provider, document, 'declaredFn(1)')));
        check('ordinary strings and comments are excluded', 2,
            (await referencesAt(provider, document, 'declaredFn(1)')).length);
        check('all declaration locations can be excluded', [],
            linesOf(await referencesAt(provider, document, 'declaredFn(1)', 0, false)));
    }

    section('6. Cancellation, unknown symbols, and untitled files');
    {
        const code = 'known := 1;\nknown;\nunknown;\n';
        const document = makeDocument('edge.g', code);
        workspaceState.documents = [document];

        check('cancelled requests return no references', 0,
            (await referencesAt(
                provider,
                document,
                'known;',
                0,
                true,
                new CancellationTokenStub(true),
            )).length);
        check('unknown symbols return no references', 0,
            (await referencesAt(provider, document, 'unknown;')).length);

        const untitled = makeDocument('Untitled-1', 'temp := 1;\ntemp;\n', null, true);
        workspaceState.documents = [untitled];
        check('untitled documents search only themselves', [0],
            linesOf(await referencesAt(provider, untitled, 'temp;', 0)));
    }

    workspaceState.folderPath = null;
    workspaceState.documents = [];
    summary();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
