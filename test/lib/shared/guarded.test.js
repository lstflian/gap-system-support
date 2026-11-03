'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setErrorReporter } = require('../../../out/shared/errors');
const { safeRename, safeUnlink, tryValue, tryValueAsync } = require('../../../out/shared/guarded');

async function main() {
    const reported = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-guarded-'));
    setErrorReporter(message => reported.push(message));
    try {
        const missing = path.join(root, 'missing.g');
        assert.equal(tryValue(() => fs.readFileSync(missing, 'utf8'), null), null);
        assert.equal(tryValue(() => fs.readFileSync(path.join(missing, 'child.g'), 'utf8'), 'fallback'), 'fallback');
        assert.equal(await tryValueAsync(() => fs.promises.readFile(missing, 'utf8'), 'fallback'), 'fallback');
        safeUnlink(missing);
        safeRename(missing, path.join(root, 'renamed.g'));
        assert.deepEqual(reported, [], 'expected missing-file probes must not be logged as errors');

        assert.equal(tryValue(() => { throw new Error('unexpected failure'); }, 'fallback'), 'fallback');
        assert.equal(await tryValueAsync(async () => { throw new Error('unexpected async failure'); }, 'fallback'), 'fallback');
        assert.equal(reported.length, 2, 'unexpected failures are still logged');
        assert.match(reported[0], /unexpected failure/);
        assert.match(reported[1], /unexpected async failure/);
        console.log('Guarded helpers stay silent for missing files and still report unexpected failures.');
    } finally {
        setErrorReporter(undefined);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
