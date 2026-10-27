'use strict';

const assert = require('assert/strict');
const {
    vscodeMock: vscode, state, setConfiguration, createFixture, opened,
} = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const extension = require('../../../out/extension');
const parser = require('../../../out/parser/gapParser');
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
        check('native tool implementations are available', 4, state.tools.size);
        check('no MCP provider by default', 0, state.providers.size);
        check('startup did not initialize WASM', false, parser.isParserReady());
        check('startup did not load a help index', 0, help.getHelpState().entries.length);
        check('startup did not register language features', 0, state.languageRegistrations);
        check('startup did not open the welcome walkthrough', false, state.executed.includes('workbench.action.openWalkthrough'));
        check('startup did not import the MCP server SDK', false,
            !!require.cache[require.resolve('../../../out/mcp/server')]);

        section('2. Workspace enable auto-starts MCP without GAP files or chat');
        setConfiguration({ 'gap.tools.enabled': false, 'gap.mcp.enabled': true });
        await waitFor(() => state.providers.size === 1);
        check('native tools can stay disabled while MCP starts', 0, state.tools.size);
        check('MCP startup still does not initialize WASM', false, parser.isParserReady());
        check('MCP startup still does not load a help index', 0, help.getHelpState().entries.length);
        await vscode.commands.executeCommand('gap.copyMcpConfiguration');
        const definition = JSON.parse(state.clipboard);
        check('copy command publishes a real authenticated HTTP endpoint', ['http', '127.0.0.1', true],
            [definition.type, new URL(definition.url).hostname, definition.headers.Authorization.startsWith('Bearer ')]);

        section('3. GAP language features still initialize with both tool switches off');
        setConfiguration({ 'gap.mcp.enabled': false });
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
