/**
 * Run the test flow: compile, help, and highlight correctness.
 */

'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const hl = path.join(root, 'test', 'highlightCases');

const gapFiles = ['mini.g', 'keywords.g'];

function run(cmd) {
    console.log(`\n=== ${cmd} ===`);
    execSync(cmd, { stdio: 'inherit', cwd: root });
}

// 1. Compile the main code.
run('npm run compile');

// 2. Generate the query txt files.
run(`node test/lib/highlight/query.js ${gapFiles.map(f => path.join(hl, f)).join(' ')}`);

// 3. Compare each json with its txt.
let allPass = true;
for (let i = 0; i < gapFiles.length; i++) {
    const name = gapFiles[i];
    const base = name.replace(/\.g$/, '');
    const jsonFile = path.join(hl, `${base}.json`);
    const txtFile = path.join(hl, `query-${base}.txt`);
    if (!fs.existsSync(jsonFile) || !fs.existsSync(txtFile)) {
        console.error(`Missing ${jsonFile} or ${txtFile}`);
        allPass = false;
        continue;
    }
    // Print the separator before the first block.
    if (i === 0) console.log('-----');
    try {
        execSync(
            `node test/lib/highlight/compare-output.js ${jsonFile} ${txtFile}`,
            { stdio: 'inherit', cwd: root },
        );
    } catch {
        allPass = false;
    }
}

// 4. Run the help tests.
const unitTests = [
    'search.test.js',
    'chooser.test.js',
    path.join('..', 'diagnostics', 'diagnostics.test.js'),
    path.join('..', 'hover', 'hover.test.js'),
    path.join('..', 'definition', 'definition.test.js'),
];
for (const file of unitTests) {
    try {
        execSync(`node test/lib/help/${file}`, { stdio: 'inherit', cwd: root });
    } catch {
        allPass = false;
    }
}

if (!allPass) {
    console.log('Some checks failed.');
    process.exit(1);
}
console.log('All checks passed.');
