/**
 * Query bridge.
 * Calls the compiled main code and writes tab separated entries per GAP file.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { installMock } = require('../highlight/mock-vscode');

// The compiled output must exist.
const outDir = path.join(__dirname, '..', '..', '..', 'out');
if (!fs.existsSync(outDir)) {
    console.error('out/ not found. Run npm run compile first.');
    process.exit(1);
}

// Install the vscode mock.
installMock();

const { initGapParser } = require('../../../out/parser/gapParser');
const { GAPSemanticTokensProvider } = require('../../../out/semantic/semanticTokensProvider');

const highlightsPath = path.join(__dirname, '..', '..', '..', 'queries', 'highlights.scm');
const localsPath = path.join(__dirname, '..', '..', '..', 'queries', 'locals.scm');

async function main() {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error('Usage: node test/lib/query.js <file.g> [more files...]');
        process.exit(1);
    }

    await initGapParser({ extensionUri: { fsPath: path.join(__dirname, '..', '..', '..') } });
    const provider = new GAPSemanticTokensProvider(highlightsPath, localsPath);

    for (const file of files) {
        const code = fs.readFileSync(file, 'utf-8');
        const entries = provider.queryEntries(code);

        const base = path.basename(file).replace(/\.[^.]+$/, '');
        const outFile = path.join(path.dirname(file), `query-${base}.txt`);
        // Line and column are 1 based in the output.
        const lines = entries.map(e =>
            [e.line + 1, e.col + 1, e.text, e.captureName, e.type ?? '-'].join('\t'));
        fs.writeFileSync(outFile, lines.join('\n') + '\n');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
