'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const {
    vscodeMock: vscode, createFixture, CancellationTokenSource,
} = require('./mock-vscode');
const { createWindowToolHost } = require('../../../out/tools/native/host');
const { CheckSyntaxTool } = require('../../../out/tools/checkSyntaxTool');
const parser = require('../../../out/language/parser/gapParser');

function document(filePath, text = 'x := ;\n') {
    return { uri: vscode.Uri.file(filePath), version: 1, isDirty: true, isClosed: false, getText: () => text };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function main() {
    const fixture = createFixture();
    const host = createWindowToolHost(fixture.context);
    const tool = new CheckSyntaxTool(host);
    const token = new CancellationTokenSource();
    const originalPlatform = os.platform;
    const originalStat = fs.promises.stat;
    const filePath = fixture.sourceFile;
    const aliasPath = filePath.toUpperCase();
    const identity = (ino = 7n, dev = 1n) => ({ ino, dev, isFile: () => true });
    const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
    let cancellation;
    try {
        await parser.initGapParser(fixture.context);
        const exact = document(filePath);
        vscode.workspace.textDocuments = [exact];
        fs.promises.stat = async () => { throw new Error('exact buffer lookup must not touch disk'); };
        assert.equal(host.openDocument(filePath), exact, 'exact lookup stays synchronous');
        assert.equal((await tool.execute({ filePath }, token.token)).syntaxValid, false);
        const deleted = document(filePath + '.deleted');
        vscode.workspace.textDocuments = [deleted];
        assert.equal((await tool.execute({ filePath: deleted.uri.fsPath }, token.token)).syntaxValid, false,
            'an exact dirty buffer remains usable even if its disk file is gone');
        const virtual = { ...exact, uri: { scheme: 'vscode-remote', fsPath: filePath } };
        vscode.workspace.textDocuments = [virtual];
        assert.equal(host.openDocument(filePath), virtual, 'exact URI matches retain their existing behavior');
        fs.promises.stat = originalStat;

        if (originalPlatform() === 'win32') {
            vscode.workspace.textDocuments = [exact];
            assert.equal((await tool.execute({ filePath: aliasPath }, token.token)).syntaxValid, false,
                'a real differently cased Windows path checks the dirty buffer');
            assert.equal(fs.readFileSync(filePath, 'utf8'), 'x := 1;\n', 'syntax checking never saves the buffer');
        }

        os.platform = () => 'win32';
        const alias = document(aliasPath);
        vscode.workspace.textDocuments = [alias];
        fs.promises.stat = async () => identity();
        assert.equal(await host.openDocument(filePath), alias, 'matching nonzero file IDs authorize the alias');
        assert.equal((await tool.execute({ filePath }, token.token)).syntaxValid, false);

        fs.promises.stat = async name => identity(name === filePath ? 7n : 8n);
        assert.equal(await host.openDocument(filePath), undefined,
            'case-sensitive Windows directories may contain distinct files with the same lowercase spelling');
        assert.equal((await tool.execute({ filePath }, token.token)).syntaxValid, true);
        fs.promises.stat = async name => identity(7n, name === filePath ? 1n : 2n);
        assert.equal(await host.openDocument(filePath), undefined, 'file IDs must be on the same device');
        fs.promises.stat = async () => identity(0n);
        assert.equal(await host.openDocument(filePath), undefined, 'unknown file IDs must not authorize a buffer');
        fs.promises.stat = async name => identity(name === filePath ? 7n : 0n);
        assert.equal(await host.openDocument(filePath), undefined);

        fs.promises.stat = async name => {
            if (name === filePath) return identity();
            throw missing();
        };
        assert.equal(await host.openDocument(filePath), undefined, 'stale candidate files are skipped');
        fs.promises.stat = async () => { throw missing(); };
        assert.equal(await host.openDocument(filePath), undefined, 'a missing request falls back to normal disk errors');
        fs.promises.stat = async name => {
            if (name === filePath) return identity();
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        };
        await assert.rejects(() => host.openDocument(filePath), error => error.code === 'EACCES');

        const secondAlias = document(filePath.replace('example.g', 'Example.g'));
        vscode.workspace.textDocuments = [alias, secondAlias];
        fs.promises.stat = async () => identity();
        await assert.rejects(() => tool.execute({ filePath }, token.token), /Multiple open documents match/,
            'ambiguous buffers must not silently fall back to valid disk content');
        vscode.workspace.textDocuments.push(exact);
        assert.equal(host.openDocument(filePath), exact, 'an exact document wins over aliases');

        for (const platform of ['linux', 'darwin']) {
            os.platform = () => platform;
            vscode.workspace.textDocuments = [alias];
            fs.promises.stat = async () => { throw new Error('non-Windows lookup must remain exact'); };
            assert.equal(host.openDocument(filePath), undefined);
            vscode.workspace.textDocuments.push(exact);
            assert.equal(host.openDocument(filePath), exact);
        }
        os.platform = () => 'win32';
        vscode.workspace.textDocuments = [{ ...alias, uri: { scheme: 'vscode-remote', fsPath: aliasPath } }];
        assert.equal(host.openDocument(filePath), undefined, 'remote URI aliases are not treated as local Windows files');

        for (const closedFlag of [false, true]) {
            const pendingDocument = document(aliasPath);
            vscode.workspace.textDocuments = [pendingDocument];
            const entered = deferred();
            const release = deferred();
            fs.promises.stat = async name => {
                if (name !== filePath) { entered.resolve(); await release.promise; }
                return identity();
            };
            const lookup = host.openDocument(filePath);
            await entered.promise;
            pendingDocument.isClosed = closedFlag;
            if (!closedFlag) vscode.workspace.textDocuments = [];
            release.resolve();
            assert.equal(await lookup, undefined, 'documents closed or removed during identity checks must be discarded');
        }

        {
            const entered = deferred();
            const release = deferred();
            vscode.workspace.textDocuments = [alias];
            fs.promises.stat = async name => {
                if (name !== filePath) { entered.resolve(); await release.promise; }
                return identity();
            };
            const lookup = host.openDocument(filePath);
            await entered.promise;
            vscode.workspace.textDocuments.push(exact);
            release.resolve();
            assert.equal(await lookup, exact, 'an exact document opened during the lookup takes priority');
        }

        {
            const entered = deferred();
            const release = deferred();
            vscode.workspace.textDocuments = [alias];
            fs.promises.stat = async name => {
                if (name !== filePath) { entered.resolve(); await release.promise; }
                return identity();
            };
            cancellation = new CancellationTokenSource();
            const running = tool.execute({ filePath }, cancellation.token);
            const rejected = assert.rejects(running, /Canceled/);
            await entered.promise;
            cancellation.cancel();
            release.resolve();
            await rejected;
            cancellation.dispose();
            cancellation = undefined;
        }

        fs.promises.stat = originalStat;
        const closedTool = new CheckSyntaxTool({ ...host, openDocument: () => Promise.resolve({ ...exact, isClosed: true }) });
        assert.equal((await closedTool.execute({ filePath }, token.token)).syntaxValid, true,
            'a document closed before an asynchronous lookup is consumed falls back to disk');
        const diskTool = new CheckSyntaxTool({ ...host, openDocument: () => undefined });
        vscode.workspace.textDocuments = [exact];
        assert.equal((await diskTool.execute({ filePath }, token.token)).syntaxValid, true,
            'standalone hosts without editors continue to check the saved file');
        console.log('Native document exact lookup, Windows file identity, ambiguity, closure, cancellation and disk fallback passed.');
    } finally {
        fs.promises.stat = originalStat;
        os.platform = originalPlatform;
        vscode.workspace.textDocuments = [];
        cancellation?.dispose();
        token.dispose();
        parser.disposeAll();
        fixture.cleanup();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
