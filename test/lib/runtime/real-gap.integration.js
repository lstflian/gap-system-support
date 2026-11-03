'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { vscodeMock: vscode } = require('../lmtools/mock-vscode');
const { initializeGapInstallation } = require('../../../out/runtime/installation');
const { GapRunner } = require('../../../out/runtime/gapRun');
const { windowRunEnvironment } = require('../../../out/tools/native/host');
const { prepareGapTerminal } = require('../../../out/runtime/terminal');

async function main() {
    const directory = process.env.GAP_TEST_INSTALLATION;
    if (!directory) { console.log('Real GAP integration skipped: set GAP_TEST_INSTALLATION to an installation folder.'); return; }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gap-runtime-integration-'));
    const previousPath = process.env.PATH;
    const runner = new GapRunner();
    const cancellation = new vscode.CancellationTokenSource();
    const timeout = setTimeout(() => cancellation.cancel(), 30000);
    let installation;
    try {
        process.env.PATH = (previousPath || '').split(path.delimiter).filter(value => !/gap-/i.test(value)).join(path.delimiter);
        const before = JSON.stringify(process.env);
        installation = initializeGapInstallation({
            extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')),
            globalState: { get: () => directory, update: async () => {} },
        });
        const source = path.join(temp, 'probe.g');
        const output = path.join(temp, 'probe.txt');
        await fs.writeFile(source, 'Print("GAP_RUNTIME_OK\\n");\n');
        await runner.run(source, output, temp, cancellation.token, windowRunEnvironment());
        assert((await fs.readFile(output, 'utf8')).includes('GAP_RUNTIME_OK'), 'real GAP must execute the source with the temporary environment');
        const terminal = await prepareGapTerminal();
        assert(terminal.command.includes('gap'));
        if (process.platform === 'win32') {
            const environment = Object.entries(terminal.env).find(([key]) => key.toLowerCase() === 'path')[1];
            assert(environment.includes(path.join('runtime', 'bin')));
            assert(environment.includes(path.join('runtime', 'opt')));
        }
        assert.equal(JSON.stringify(process.env) === before, true, 'running GAP must not change the inherited environment');
        console.log('Real GAP ran with installation paths removed from inherited PATH; terminal environment is consistent.');
    } finally {
        await runner.close();
        clearTimeout(timeout);
        cancellation.dispose();
        installation?.dispose();
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        await fs.rm(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
