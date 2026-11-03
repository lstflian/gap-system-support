'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { initGapParser, disposeAll } = require('../../../out/language/parser/gapParser');
const { GAPDefinitionResolver } = require('../../../out/language/analysis/definitionResolver');
const { WORKSPACE_SYMBOL_CACHE_MAX_ENTRIES } = require('../../../out/limits');

const extensionRoot = path.resolve(__dirname, '../../..');

function document(filePath, text, isUntitled = false) {
    const lines = text.split('\n');
    return {
        uri: { fsPath: isUntitled ? '' : filePath, toString: () => isUntitled ? 'untitled:cache-test' : pathToFileURL(filePath).href },
        version: 1, isUntitled, getText: () => text,
        offsetAt: position => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
    };
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-definition-cache-'));
    const originalNow = Date.now;
    let now = originalNow();
    let resolver;
    try {
        await initGapParser({ extensionUri: { fsPath: extensionRoot } });
        Date.now = () => now;
        const aPath = path.join(root, 'a.g');
        const bPath = path.join(root, 'b.g');
        const aText = 'SharedCache();\nSharedCache := function() return 1; end;\n';
        const bText = 'SharedCache();\nSharedCache := function() return 2; end;\n';
        fs.writeFileSync(aPath, aText);
        fs.writeFileSync(bPath, bText);
        const a = document(aPath, aText);
        const b = document(bPath, bText);
        const untitled = document('', 'SharedCache();\n', true);
        let documents = [a, b];
        let workspace = root;
        resolver = new GAPDefinitionResolver(path.join(extensionRoot, 'queries', 'completion.scm'), {
            openDocuments: () => documents, workspaceRoot: () => workspace,
        });
        let scans = 0;
        const scan = resolver.scanWorkspaceSymbolDefinitions.bind(resolver);
        resolver.scanWorkspaceSymbolDefinitions = (...args) => { scans++; return scan(...args); };
        const lookup = doc => resolver.resolveDefinitions(doc, { line: 0, character: 2 }, 'SharedCache').map(result => result.filePath);

        for (const order of [[a, b], [b, a]]) {
            resolver.onWorkspaceFilesChanged();
            const before = scans;
            for (const doc of [...order, ...order]) {
                assert.deepEqual(lookup(doc), doc === a ? [bPath] : [aPath]);
            }
            assert.equal(scans - before, 2, 'repeated lookups reuse the cache for their own caller');
        }
        assert.deepEqual(lookup(untitled), [aPath, bPath], 'untitled callers must not exclude a saved file');
        assert.deepEqual(lookup(a), [bPath]);
        const otherRoot = path.join(root, 'other');
        fs.mkdirSync(otherRoot);
        const otherFile = path.join(otherRoot, 'other.g');
        fs.writeFileSync(otherFile, 'SharedCache := function() return 3; end;\n');
        workspace = otherRoot;
        assert.deepEqual(lookup(untitled), [otherFile], 'workspace roots remain separate cache inputs');
        workspace = root;
        fs.rmSync(otherRoot, { recursive: true });
        resolver.onWorkspaceFilesChanged();

        const beforeLocal = scans;
        const local = resolver.resolveDefinition(a, { line: 1, character: 2 }, 'SharedCache');
        assert.equal(local.filePath, aPath);
        const readDoc = document(path.join(root, 'read.g'), 'Read("b.g");\nSharedCache();\n');
        const read = resolver.resolveDefinition(readDoc, { line: 1, character: 2 }, 'SharedCache');
        assert.equal(read.filePath, bPath);
        assert.equal(scans, beforeLocal, 'local and Read-chain lookups do not populate the workspace fallback cache');

        for (const [dirtyText, expectedBeforeClose] of [
            ['OtherName := 1;\n', false],
            ['SharedCache := function() return 99; end;\n', true],
        ]) {
            resolver.onWorkspaceFilesChanged();
            const dirty = document(bPath, dirtyText);
            dirty.version = expectedBeforeClose ? 3 : 2;
            documents = [a, dirty];
            const beforeClose = resolver.resolveWorkspaceDefinition(a, 'SharedCache');
            assert.equal(!!beforeClose, expectedBeforeClose);
            if (beforeClose) assert.equal(beforeClose.row, 0);
            documents = [a];
            resolver.onDocumentClosed(dirty.uri);
            const afterClose = resolver.resolveWorkspaceDefinition(a, 'SharedCache');
            assert.equal(afterClose.filePath, bPath);
            assert.equal(afterClose.row, 1, 'discarded sibling buffers invalidate positive and negative results');
        }

        resolver.onWorkspaceFilesChanged();
        documents = [a, b];
        const first = resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        const capacity = WORKSPACE_SYMBOL_CACHE_MAX_ENTRIES;
        for (let i = 0; i < capacity - 1; i++) resolver.resolveWorkspaceDefinition(a, `Missing${i}`);
        assert.equal(resolver.workspaceSymbolCache.size, capacity);
        const beforeHit = scans;
        resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        assert.equal(scans, beforeHit);
        resolver.resolveWorkspaceDefinition(a, 'Overflow');
        assert.equal(resolver.workspaceSymbolCache.size, capacity);
        const afterOverflow = scans;
        resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        assert.equal(scans, afterOverflow, 'a cache hit must refresh recency');
        resolver.resolveWorkspaceDefinition(a, 'Missing0');
        assert.equal(scans, afterOverflow + 1, 'least recently used entries must be rescanned after eviction');
        assert.equal(resolver.workspaceSymbolCache.size, capacity);

        resolver.onWorkspaceFilesChanged();
        resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        now += 4999;
        const beforeExpiry = scans;
        resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        assert.equal(scans, beforeExpiry, 'entries remain valid before the TTL boundary');
        resolver.resolveWorkspaceDefinition(a, 'StillFresh');
        now += 1;
        resolver.resolveWorkspaceDefinition(a, 'StillFresh');
        assert.equal(resolver.workspaceSymbolCache.size, 1, 'a valid hit must also sweep other expired entries');
        const refreshed = resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        assert.equal(scans, beforeExpiry + 2, 'hits do not extend the fixed five-second TTL');
        assert.deepEqual(refreshed, first, 'expiry and eviction must not change lookup results');
        assert.equal(resolver.workspaceSymbolCache.size, 2);

        resolver.onWorkspaceFilesChanged();
        assert.equal(resolver.workspaceSymbolCache.size, 0);
        resolver.resolveWorkspaceDefinition(a, 'SharedCache');
        resolver.dispose();
        assert.equal(resolver.workspaceSymbolCache.size, 0);
        console.log('Definition cache caller isolation, lookup precedence, discarded buffers, LRU bounds and fixed TTL passed.');
    } finally {
        Date.now = originalNow;
        resolver?.dispose();
        disposeAll();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
