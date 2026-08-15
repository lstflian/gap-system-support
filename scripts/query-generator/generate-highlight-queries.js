/**
 * Generate ordered viewport and global Tree-sitter highlight queries.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const sourcePath = path.join(root, 'queries', 'highlights.source.scm');
const targets = {
    viewport: path.join(root, 'queries', 'highlights.scm'),
    global: path.join(root, 'queries', 'highlights.global.scm'),
};
const viewportBegin = '; @gap-query viewport-only begin';
const viewportEnd = '; @gap-query viewport-only end';
const expectedViewportRegions = 3;

function generateHighlightQueries(source) {
    const normalized = source.replace(/\r\n?/g, '\n');
    if (!normalized.endsWith('\n')) {
        throw new Error('Highlight query source must end with a newline.');
    }

    const viewport = [];
    const global = [];
    let inViewportRegion = false;
    let viewportRegions = 0;

    for (const line of normalized.split('\n')) {
        if (line === viewportBegin) {
            if (inViewportRegion) throw new Error('Nested viewport-only query region.');
            inViewportRegion = true;
            viewportRegions++;
            continue;
        }
        if (line === viewportEnd) {
            if (!inViewportRegion) throw new Error('Viewport-only query region ends without a start.');
            inViewportRegion = false;
            continue;
        }
        viewport.push(line);
        if (!inViewportRegion) global.push(line);
    }

    if (inViewportRegion) throw new Error('Unclosed viewport-only query region.');
    if (viewportRegions !== expectedViewportRegions) {
        throw new Error(`Expected ${expectedViewportRegions} viewport-only regions, found ${viewportRegions}.`);
    }
    return { viewport: viewport.join('\n'), global: global.join('\n') };
}

function loadGeneratedQueries() {
    return generateHighlightQueries(fs.readFileSync(sourcePath, 'utf8'));
}

function checkGeneratedQueries(generated) {
    let valid = true;
    for (const [name, targetPath] of Object.entries(targets)) {
        const actual = fs.readFileSync(targetPath, 'utf8');
        if (actual !== generated[name]) {
            console.error(`${path.relative(root, targetPath)} is stale. Run npm run generate:highlight-queries.`);
            valid = false;
        }
    }
    return valid;
}

function writeGeneratedQueries(generated) {
    for (const [name, targetPath] of Object.entries(targets)) {
        fs.writeFileSync(targetPath, generated[name], 'utf8');
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const writeMode = args.length === 0;
    const checkMode = args.length === 1 && args[0] === '--check';
    if (!writeMode && !checkMode) {
        console.error('Usage: node scripts/query-generator/generate-highlight-queries.js [--check]');
        process.exitCode = 2;
    } else if (writeMode) {
        const generated = loadGeneratedQueries();
        writeGeneratedQueries(generated);
        console.log('Generated ordered highlight queries.');
    } else {
        const generated = loadGeneratedQueries();
        if (!checkGeneratedQueries(generated)) process.exitCode = 1;
    }
}

module.exports = {
    checkGeneratedQueries,
    generateHighlightQueries,
    loadGeneratedQueries,
    sourcePath,
    targets,
};
