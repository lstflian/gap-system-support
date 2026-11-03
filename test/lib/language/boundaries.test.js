'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../..');
const load = Module._load;
Module._load = function (request, ...rest) {
    assert.notEqual(request, 'vscode', 'language core must run without VS Code');
    return load.call(this, request, ...rest);
};
function files(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
try {
    for (const file of files(path.join(root, 'out/language')).filter(file => file.endsWith('.js'))) require(file);
    for (const file of files(path.join(root, 'src/language/analysis')).filter(file => file.endsWith('.ts'))) {
        const text = fs.readFileSync(file, 'utf8');
        assert(!/from ['"][^'"]*(?:semantic|editor)\//.test(text), `${file}: shared facts must not depend on feature projections`);
        assert(!/\b(?:TokenMapping|SemanticTokens|CAPTURE_MAP)\b/.test(text), `${file}: shared facts must not contain highlight mappings`);
    }
    for (const file of files(path.join(root, 'src/runtime')).filter(file => file.endsWith('.ts'))) {
        assert(!/from ['"][^'"]*(?:tools|editor)\//.test(fs.readFileSync(file, 'utf8')));
    }
    console.log('Language core loads without VS Code; shared analysis has no highlight dependency; runtime has no editor/tool dependency.');
} finally { Module._load = load; }
