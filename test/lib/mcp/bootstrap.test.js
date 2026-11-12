'use strict';

const assert = require('assert/strict');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, opened,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const extension = require('../../../out/extension');
const parser = require('../../../out/language/parser/gapParser');
const help = require('../../../out/help/helpData');

async function waitFor(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert(Date.now() < deadline, 'feature initialization timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function main() {
    const fixture = createFixture();
    try {
        section('1. Startup without GAP files stays lightweight by default');
        await extension.activate(fixture.context);
        check('native tool implementations are available', 5, state.tools.size);
        const provider = state.providers.get('gap.mcp');
        check('the MCP provider is registered but provides no server by default', [1, []],
            [state.providers.size, await provider.provideMcpServerDefinitions()]);
        check('startup did not initialize WASM', false, parser.isParserReady());
        check('startup did not load a help index', 0, help.getHelpState().entries.length);
        check('startup did not register language features', 0, state.languageRegistrations);
        check('startup did not open the welcome walkthrough', false, state.executed.includes('workbench.action.openWalkthrough'));
        const sdkLoaded = () => Object.keys(require.cache).some(key => key.includes('@modelcontextprotocol'));
        check('the extension host never imports the MCP server SDK', false, sdkLoaded());

        section('2. Enabling MCP publishes a stdio server without GAP files or chat');
        setConfiguration({ 'gap.tools.enabled': false, 'gap.mcp.enabled': true }, 'workspace');
        const [definition] = await provider.provideMcpServerDefinitions();
        check('enabled MCP provides one stdio server', ['GAP', process.execPath], [definition?.label, definition?.command]);
        check('native tools can stay disabled while MCP is enabled', 0, state.tools.size);
        check('providing MCP does not initialize WASM', false, parser.isParserReady());
        check('providing MCP does not load a help index', 0, help.getHelpState().entries.length);
        check('providing MCP does not import the MCP server SDK', false, sdkLoaded());
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        const copied = JSON.parse(state.clipboard);
        check('copy command publishes the stdio launch configuration', ['stdio', definition.command, definition.args],
            [copied.type, copied.command, copied.args]);

        section('3. GAP language features still initialize with both tool switches off');
        setConfiguration({ 'gap.mcp.enabled': false }, 'workspace');
        const text = 'x := 1;\n';
        const document = {
            uri: vscode.Uri.file(fixture.sourceFile), fileName: fixture.sourceFile,
            languageId: 'gap', version: 1, getText: () => text,
            positionAt(offset) {
                const before = text.slice(0, offset).split('\n');
                return new vscode.Position(before.length - 1, before.at(-1).length);
            },
        };
        vscode.workspace.textDocuments.push(document);
        opened.fire(document);
        await waitFor(() => state.languageRegistrations === 6 || state.messages.some(message => message.type === 'error'));
        check('language feature activation reports no error', [], state.messages.filter(message => message.type === 'error'));
        check('all six language providers are registered', 6, state.languageRegistrations);
        check('parser is ready for ordinary editing', true, parser.isParserReady());
        check('language activation does not re-enable native tools', 0, state.tools.size);
        check('welcome walkthrough opens on actual GAP feature use', true, state.executed.includes('workbench.action.openWalkthrough'));

        section('4. Native registration failure is isolated and does not leak listeners');
        await extension.deactivate();
        for (const subscription of fixture.context.subscriptions.splice(0)) subscription.dispose();
        const registerTool = vscode.lm.registerTool;
        let attempts = 0;
        try {
            vscode.lm.registerTool = () => { attempts++; throw new Error('test native registration failure'); };
            setConfiguration({ 'gap.tools.enabled': true });
            await extension.activate(fixture.context);
            check('registration failure is reported', true,
                state.messages.some(message => message.type === 'error' && message.message.includes('test native registration failure')));
            check('editor providers survive native registration failure', 6, state.languageRegistrations);
            check('parser survives native registration failure', true, parser.isParserReady());
            setConfiguration({ 'gap.tools.enabled': false });
            setConfiguration({ 'gap.tools.enabled': true });
            check('failed construction removes its configuration listener', 1, attempts);
        } finally { vscode.lm.registerTool = registerTool; }
        summary();
    } finally {
        await extension.deactivate();
        for (const subscription of fixture.context.subscriptions) subscription.dispose();
        fixture.cleanup();
    }
    assert.equal(state.tools.size, 0);
    assert.equal(state.providers.size, 0);
    assert.equal(state.commands.size, 0);
    assert.equal(state.languageRegistrations, 0);
    assert.equal(parser.isParserReady(), false);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
