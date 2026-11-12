'use strict';

const assert = require('assert/strict');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, CancellationTokenSource,
} = require('./mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { createToolRegistry } = require('../../../out/tools/registry');
const { LmToolsController } = require('../../../out/tools/native');
const { createWindowToolHost, createWindowToolRegistry } = require('../../../out/tools/native/host');
const parser = require('../../../out/language/parser/gapParser');
const manifest = require('../../../package.json');

async function main() {
    const fixture = createFixture();
    const token = new CancellationTokenSource();
    const registry = createWindowToolRegistry(fixture.context);
    const entries = new Map();
    registry.forEach(entry => entries.set(entry.metadata.name, entry));
    let controller;
    try {
        section('1. Manifest and shared tool metadata');
        check('native tools enabled by default', true, manifest.contributes.configuration.properties['gap.tools.enabled'].default);
        check('MCP disabled by default', false, manifest.contributes.configuration.properties['gap.mcp.enabled'].default);
        check('native and MCP switches are window-scoped', ['window', 'window'], [
            manifest.contributes.configuration.properties['gap.tools.enabled'].scope,
            manifest.contributes.configuration.properties['gap.mcp.enabled'].scope,
        ]);
        check('all native contributions have a condition', true,
            manifest.contributes.languageModelTools.every(tool => tool.when.includes('config.gap.tools.enabled')));
        check('five shared implementations', 5, entries.size);
        check('tool identifiers', ['gapSearchHelp', 'gapListBooks', 'gapResolveLink', 'gapCheckSyntax', 'gapRunFile'], [...entries.keys()]);
        check('running requires trust in the contribution condition', 'config.gap.tools.enabled && isWorkspaceTrusted',
            entries.get('gapRunFile') && manifest.contributes.languageModelTools.find(tool => tool.name === 'gapRunFile').when);
        for (const contribution of manifest.contributes.languageModelTools) {
            const metadata = entries.get(contribution.name).metadata;
            check(`${contribution.name} has one name for tool, reference and display`, [contribution.name, contribution.name],
                [contribution.toolReferenceName, contribution.displayName]);
            check(`${contribution.name} uses manifest schema`, contribution.inputSchema, metadata.inputSchema);
            check(`${contribution.name} uses manifest description`, contribution.modelDescription, metadata.modelDescription);
            check(`${contribution.name} descriptions only name current tools`, false,
                /search_gap_help|list_gap_books|gap_resolve_link|check_gap_syntax|run_gap_file/.test(JSON.stringify(contribution)));
        }
        const host = createWindowToolHost(fixture.context);
        assert.throws(() => createToolRegistry({ ...manifest, contributes: { languageModelTools: [] } }, host), /manifest/);
        for (const field of ['displayName', 'toolReferenceName']) {
            assert.throws(() => createToolRegistry({
                ...manifest,
                contributes: {
                    languageModelTools: manifest.contributes.languageModelTools.map((tool, index) =>
                        index === 0 ? { ...tool, [field]: 'Search GAP Help' } : tool),
                },
            }, host), /manifest/, `a different ${field} is rejected`);
        }

        section('2. Registration, single-flight parser initialization and results');
        controller = new LmToolsController(registry);
        check('five native tools registered', 5, state.tools.size);
        const first = parser.initGapParser(fixture.context);
        check('concurrent parser initialization shares one promise', true, first === parser.initGapParser(fixture.context));
        await first;
        for (const [name, entry] of entries) {
            const expected = await entry.tool.execute(fixture.inputs[name], token.token);
            check(`${name} prepares an invocation message`, 'string', typeof entry.tool.prepare(fixture.inputs[name]).invocationMessage);
            const native = await state.tools.get(name).invoke({ input: fixture.inputs[name], toolInvocationToken: undefined }, token.token);
            check(`${name} native result equals shared result`, expected, JSON.parse(native.content[0].value));
        }
        const search = await entries.get('gapSearchHelp').tool.execute(fixture.inputs.gapSearchHelp, token.token);
        check('search paging preserves the full match count', [3, 1], [search.total, search.returned]);
        check('distribution is not truncated by paging', { Reference: 2, Tutorial: 1 }, search.distribution);
        check('search returns the exact anchor location', [fixture.helpFile, 3], [search.results[0].absPath, search.results[0].targetLine]);
        vscode.workspace.textDocuments = [{
            uri: vscode.Uri.file(fixture.sourceFile), getText: () => 'x := ;\n',
        }];
        const unsaved = await state.tools.get('gapCheckSyntax').invoke({
            input: fixture.inputs.gapCheckSyntax, toolInvocationToken: undefined,
        }, token.token);
        check('unsaved buffer takes priority over valid disk contents', false, JSON.parse(unsaved.content[0].value).syntaxValid);
        vscode.workspace.textDocuments = [];

        section('3. Live disable, stale handles and independent MCP setting');
        const stale = state.tools.get('gapListBooks');
        const registrationCount = state.toolRegistrations;
        setConfiguration({ 'gap.mcp.enabled': true });
        check('MCP flag does not change native registration', registrationCount, state.toolRegistrations);
        setConfiguration({ 'gap.tools.enabled': false });
        check('disabling unregisters every native tool', 0, state.tools.size);
        await assert.rejects(() => stale.invoke({ input: {} }, token.token), /disabled/);
        assert.throws(() => stale.prepareInvocation({ input: {} }, token.token), /disabled/);
        setConfiguration({ 'gap.tools.enabled': true });
        check('re-enabling registers all five tools', 5, state.tools.size);
        setConfiguration({ 'gap.tools.enabled': true });
        check('identical config events do not duplicate registrations', registrationCount + 5, state.toolRegistrations);
        await assert.rejects(() => stale.invoke({ input: {} }, token.token), /disabled/);
        const cancelled = new CancellationTokenSource();
        cancelled.cancel();
        await assert.rejects(() => state.tools.get('gapListBooks').invoke({ input: {} }, cancelled.token), /Canceled/);
        cancelled.dispose();
        controller.dispose();

        section('4. Disabling cancels an invocation already awaiting work');
        let started;
        const startedPromise = new Promise(resolve => { started = resolve; });
        controller = new LmToolsController({
            version: 'test',
            forEach(visitor) {
                visitor({
                    metadata: { name: 'pending' },
                    tool: {
                        execute: (_input, invocationToken) => new Promise((_resolve, reject) => {
                            invocationToken.onCancellationRequested(() => reject(new vscode.CancellationError()));
                            started();
                        }),
                        prepare: () => ({ invocationMessage: 'pending' }),
                    },
                });
            },
        });
        const pending = state.tools.get('pending').invoke({ input: {} }, token.token);
        const rejected = assert.rejects(pending, /Canceled/);
        await startedPromise;
        setConfiguration({ 'gap.tools.enabled': false });
        await rejected;
        check('no native registration remains after cancellation', 0, state.tools.size);
        controller.dispose();

        section('5. Parser initialization failure, cancellation and retry');
        parser.disposeAll();
        await assert.rejects(parser.initGapParser({
            ...fixture.context, extensionUri: vscode.Uri.file(fixture.root),
        }), /ENOENT/);
        check('failed parser initialization leaves no parser', false, parser.isParserReady());
        const initializing = parser.initGapParser(fixture.context);
        const initializationRejected = assert.rejects(initializing, /Canceled/);
        parser.disposeAll();
        await initializationRejected;
        check('disposed initialization cannot resurrect the parser', false, parser.isParserReady());
        await parser.initGapParser(fixture.context);
        check('parser can be initialized after failure and disposal', true, parser.isParserReady());
        summary();
    } finally {
        controller?.dispose();
        token.dispose();
        await registry.close();
        parser.disposeAll();
        fixture.cleanup();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
