'use strict';
const fs = require('fs');
const path = require('path');

// Compare the expected json with the query txt output.
// JSON provides [line, col, expected], txt provides [line, col, actual].

const jsonPath = process.argv[2];
const txtPath = process.argv[3];
if (!jsonPath || !txtPath) {
    console.error('Usage: node test/compare-output.js <compare-*.json> <query-*.txt>');
    process.exit(1);
}

const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
const txtLines = fs.readFileSync(txtPath, 'utf-8').split('\n').filter(l => l.trim() !== '');

// The file name this run compares, relative to the project root.
const relName = json.file.replace(/\.g$/, '');

// Index txt entries by "line,col".
const txtMap = new Map();
for (const line of txtLines) {
    const parts = line.split('\t');
    const key = `${parts[0]},${parts[1]}`;
    // Keep the first occurrence.
    if (!txtMap.has(key)) {
        txtMap.set(key, {
            line: parts[0],
            col: parts[1],
            text: parts[2],
            actual: parts[3],
            mappedType: parts[4],
        });
    }
}

let pass = 0;
let fail = 0;
let missing = 0;
const failures = [];

for (const a of json.assertions) {
    const key = `${a.line},${a.col}`;
    const txt = txtMap.get(key);
    if (!txt) {
        missing++;
        failures.push({ line: a.line, col: a.col, text: a.text, expected: a.expected, actual: '(missing)' });
        continue;
    }

    if (txt.actual === a.expected) {
        pass++;
    } else {
        fail++;
        failures.push({ line: a.line, col: a.col, text: a.text, expected: a.expected, actual: txt.actual });
    }
}

if (failures.length === 0) {
    // Print the result line, closed by a separator.
    console.log(`${relName}.g highlighting matches the expected behavior`);
    console.log('-----');
    return;
}

for (const f of failures) {
    console.log(`file: ${relName}.g`);
    console.log(`  text: ${f.text}`);
    console.log(`  line: ${f.line}`);
    console.log(`  col: ${f.col}`);
    console.log(`  expected: ${f.expected}`);
    console.log(`  actual: ${f.actual}`);
    console.log('-----');
}
// Set the exit code to 1 on failure.
process.exitCode = 1;
