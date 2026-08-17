/**
 * Strip ANSI codes and clean URL paths.
 */
const fs = require('fs');
const path = require('path');
const CWD = process.cwd();

function cleanFile(filename, fields, stripDisplay) {
    const file = path.join(CWD, filename);
    if (!fs.existsSync(file)) {
        console.log(`${filename} not found, skipping`);
        return 0;
    }

    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
    const result = [];

    for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < fields) continue;

        let [bookDir, url, display, ...rest] = parts;
        if (stripDisplay) display = display.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
        url = url.replace(/^.*?(?=\/(doc\/|pkg\/))/, '');

        result.push([bookDir, url, display, ...rest].join('|'));
    }

    fs.writeFileSync(file, result.join('\n') + '\n');
    return result.length;
}

const n1 = cleanFile('export_gapdoc.txt', 6, true);
const n2 = cleanFile('export_default.txt', 9, false);
console.log(`Converted — gapdoc: ${n1}, default: ${n2}`);
