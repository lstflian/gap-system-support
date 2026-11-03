'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, CancellationTokenSource,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { McpController } = require('../../../out/tools/mcp');
const { containingRoot, settingsFromEnvironment, settingsToEnvironment } = require('../../../out/tools/mcp/environment');
const { createWindowToolRegistry } = require('../../../out/tools/native/host');
const { connect, toolOutput, waitFor, log, alive, record, stopped, source } = require('./helpers');
const manifest = require('../../../package.json');

const script = path.resolve(__dirname, '..', '..', '..', 'out', 'tools', 'mcp', 'stdio.js');

async function main() {
    const fixture = createFixture();
    const sessions = [];
    let controller;
    let registry;
    const token = new CancellationTokenSource();
    try {
        section('1. The stdio server is plain Node.js and never loads the vscode module');
        const probe = spawnSync(process.execPath, ['-e', `
            const Module = require('node:module');
            const load = Module._load;
            Module._load = function (request, ...rest) {
                if (request === 'vscode') throw new Error('vscode was loaded');
                return load.call(this, request, ...rest);
            };
            require(${JSON.stringify(script)});
            process.stdout.write(String(Object.keys(require.cache).some(key => key.includes('@modelcontextprotocol'))));
        `], { encoding: 'utf8' });
        check('the server module graph loads without vscode', [0, 'true'], [probe.status, probe.stdout]);
        const parsed = settingsFromEnvironment(settingsToEnvironment({
            storage: '/s', docPath: ' /d ', pkgPath: '/p', searchMode: 'substring', shell: '/bin/zsh', terminalRoot: '/',
            wslProfileArgs: ['-d', 'Ubuntu'], gapDirectory: '/gap', workspaceRoots: ['/w', 'relative'],
        }));
        check('settings round-trip through the environment', {
            storage: '/s', docPath: '/d', pkgPath: '/p', searchMode: 'substring', shell: '/bin/zsh', terminalRoot: '/',
            wslProfileArgs: ['-d', 'Ubuntu'], gapDirectory: '/gap', workspaceRoots: path.isAbsolute('/w') ? ['/w'] : [],
        }, parsed);
        const defaults = settingsFromEnvironment({});
        check('missing settings fall back to safe defaults', ['prefix', '', [], undefined],
            [defaults.searchMode, defaults.docPath, defaults.workspaceRoots, defaults.gapDirectory]);
        const outer = path.join(fixture.root, 'outer');
        const inner = path.join(outer, 'inner');
        check('the innermost workspace folder is the default cwd', inner,
            containingRoot(path.join(inner, 'a', 'b.g'), [outer, inner]));
        check('a sibling with a shared prefix is not a parent', undefined,
            containingRoot(path.join(fixture.root, 'outer-other', 'b.g'), [outer]));

        section('2. The provided definition starts a working server for 2025 and modern clients');
        const workspace = path.join(fixture.root, 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'workspace', index: 0 }];
        setConfiguration({ 'gap.mcp.enabled': true });
        controller = new McpController(fixture.context, {
            selectedDirectory: () => fixture.bin, onDidChangeSelection: () => ({ dispose() {} }),
        });
        const [definition] = await state.providers.get('gap.mcp').provideMcpServerDefinitions();
        registry = createWindowToolRegistry(fixture.context);
        const native = new Map();
        registry.forEach(entry => native.set(entry.metadata.name, entry));
        const contributions = manifest.contributes.languageModelTools;
        for (const modern of [false, true]) {
            const session = await connect(definition, { modern });
            sessions.push(session);
            const { tools } = await session.client.listTools();
            check(`${modern ? 'modern' : '2025'} client lists the five tools in manifest order`,
                contributions.map(tool => tool.name), tools.map(tool => tool.name));
            check('MCP titles are the unified tool names', contributions.map(tool => tool.name), tools.map(tool => tool.title));
            check('MCP descriptions come from the manifest', contributions.map(tool => tool.modelDescription),
                tools.map(tool => tool.description));
            check('MCP schemas keep the manifest properties', contributions.map(tool => [
                Object.keys(tool.inputSchema.properties).sort(), tool.inputSchema.required ?? [],
            ]), tools.map(tool => [Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.inputSchema.required ?? []]));
            check('only gapRunFile is destructive', ['gapRunFile'],
                tools.filter(tool => tool.annotations?.destructiveHint).map(tool => tool.name));
            for (const name of ['gapSearchHelp', 'gapListBooks', 'gapResolveLink']) {
                check(`${name} matches the native implementation`,
                    await native.get(name).tool.execute(fixture.inputs[name], token.token),
                    toolOutput(await session.client.callTool({ name, arguments: fixture.inputs[name] })));
            }
            const invalid = await session.client.callTool({ name: 'gapSearchHelp', arguments: { topic: 'Group', books: ['Nope'] } });
            check('tool errors are MCP errors that name the current tools', [true, true],
                [invalid.isError, invalid.content[0].text.includes('gapListBooks')]);
        }
        await sessions.pop().client.close();

        section('3. Syntax checks read the file on disk; a rebuilt help index is reloaded');
        const { client, stderr } = sessions[0];
        const broken = path.join(workspace, 'broken.g');
        fs.writeFileSync(broken, 'x := ;\n');
        vscode.workspace.textDocuments = [{ uri: vscode.Uri.file(broken), getText: () => 'x := 1;\n' }];
        const syntax = toolOutput(await client.callTool({ name: 'gapCheckSyntax', arguments: { filePath: broken } }));
        check('the server checks the saved file, not an editor buffer', [false, 1], [syntax.syntaxValid, syntax.diagnostics[0].line]);
        vscode.workspace.textDocuments = [];
        const index = path.join(fixture.context.globalStorageUri.fsPath, 'data', 'helpIndex', 'export_default.txt');
        await new Promise(resolve => setTimeout(resolve, 20));
        fs.appendFileSync(index, '\n/doc/new|/doc/new/chap1.html#New|New|new|NewBook|1|1|S|New manual');
        check('a rebuilt index is visible without restarting the server', ['NewBook', 'Reference', 'Tutorial'],
            toolOutput(await client.callTool({ name: 'gapListBooks', arguments: {} })).books);
        check('diagnostics never reach stdout', true, stderr.join('').includes('parser initialized'));

        section('4. GAP runs through the selected installation with live output and cancellation');
        const file = path.join(workspace, 'nested', 'run.g');
        const output = path.join(fixture.root, 'logs', 'mcp.txt');
        source(file);
        check('a run completes', { completed: true }, toolOutput(await client.callTool({
            name: 'gapRunFile', arguments: { filePath: file, outputPath: output },
        })));
        const info = await record(output);
        check('the file runs quietly from its workspace folder', [['-q', '--nointeract', '*stdin*', file], workspace.toLowerCase()],
            [info.args, info.cwd.toLowerCase()]);
        check('the output contains the program output', true, log(output).includes('finished\n'));
        source(file, { hang: true, spawnChild: true });
        const abort = new AbortController();
        const pending = client.callTool({ name: 'gapRunFile', arguments: { filePath: file, outputPath: output } },
            { signal: abort.signal }).then(value => ({ value }), error => ({ error }));
        const running = await record(output, true);
        const busy = await client.callTool({ name: 'gapRunFile', arguments: { filePath: file, outputPath: output } });
        check('a second run cannot write the same output', [true, true], [busy.isError, /already writing/.test(busy.content[0].text)]);
        abort.abort();
        check('the cancelled call fails', true, !!(await pending).error);
        await stopped(running);
        check('cancellation stops the GAP process tree', false, alive(running.pid));

        section('5. Closing the connection stops running GAP processes and the server');
        const orphanOutput = path.join(fixture.root, 'logs', 'orphan.txt');
        const pendingAtExit = client.callTool({ name: 'gapRunFile', arguments: { filePath: file, outputPath: orphanOutput } })
            .then(value => ({ value }), error => ({ error }));
        const orphanCandidate = await record(orphanOutput, true);
        const serverPid = sessions[0].transport.pid;
        await client.close();
        sessions.pop();
        await pendingAtExit;
        await stopped(orphanCandidate);
        check('GAP does not outlive the server', false, alive(orphanCandidate.pid));
        await waitFor(() => !alive(serverPid), 'The stdio server did not exit after its client closed');
        check('the server exits when its client closes stdin', false, alive(serverPid));
        summary();
    } finally {
        for (const session of sessions) await session.client.close();
        controller?.dispose();
        await registry?.close();
        token.dispose();
        vscode.workspace.workspaceFolders = [];
        setConfiguration({ 'gap.mcp.enabled': undefined });
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
