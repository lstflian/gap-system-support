'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

async function findGap({ directory, pathOnly = false, environment = process.env, platform = process.platform } = {}) {
    const windows = platform === 'win32';
    const candidates = new Map();
    const issues = [];
    const visited = new Set();
    const launchers = windows ? ['gap.exe', 'gap.cmd', 'gap.bat', 'gap.com'] : ['gap', 'gap.sh'];
    const missing = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
    async function stat(file) {
        try { return await fs.stat(file); }
        catch (error) {
            if (!missing(error)) issues.push({ code: error.code || 'IO_ERROR', path: file });
            return undefined;
        }
    }
    async function children(folder, pattern) {
        try {
            return (await fs.readdir(folder, { withFileTypes: true }))
                .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && pattern.test(entry.name))
                .map(entry => path.join(folder, entry.name));
        } catch (error) {
            if (!missing(error)) issues.push({ code: error.code || 'IO_ERROR', path: folder });
            return [];
        }
    }
    async function inspect(folder) {
        const key = windows ? folder.toLowerCase() : folder;
        if (visited.has(key)) return;
        visited.add(key);
        for (const name of launchers) {
            const executable = path.join(folder, name);
            if (!(await stat(executable))?.isFile()) continue;
            try {
                await fs.access(executable, windows ? constants.F_OK : constants.X_OK);
                const real = await fs.realpath(executable);
                const home = path.basename(folder).toLowerCase() === 'bin' ? path.dirname(folder) : folder;
                const environmentDirectories = [folder];
                if (windows && path.basename(path.dirname(folder)).toLowerCase() === 'opt'
                    && path.basename(path.dirname(path.dirname(folder))).toLowerCase() === 'runtime') {
                    const bin = path.join(path.dirname(path.dirname(folder)), 'bin');
                    if (!(await stat(bin))?.isDirectory()) {
                        issues.push({ code: 'MISSING_RUNTIME_BIN', path: bin });
                        continue;
                    }
                    environmentDirectories.push(bin);
                }
                const optional = async name => (await stat(path.join(home, name)))?.isDirectory() ? path.join(home, name) : undefined;
                candidates.set(windows ? real.toLowerCase() : real, {
                    directory: folder, executable, environmentDirectories,
                    docPath: await optional('doc'), pkgPath: await optional('pkg'),
                });
                break;
            } catch (error) {
                issues.push({ code: error.code || 'IO_ERROR', path: executable });
            }
        }
    }
    async function installation(root) {
        const bundled = [];
        const runtimes = windows ? [path.join(root, 'runtime'), root] : [];
        for (const runtime of runtimes) {
            bundled.push(...await children(path.join(runtime, 'opt'), /^gap(?:-|$)/i));
        }
        for (const gap of bundled) await inspect(gap);
        if (!bundled.length) {
            await inspect(root);
            await inspect(path.join(root, 'bin'));
        }
        for (const gap of await children(root, /^gap(?:-|$)/i)) {
            await inspect(gap);
            await inspect(path.join(gap, 'bin'));
        }
    }
    if (directory) {
        await installation(path.resolve(directory));
    } else {
        const envPath = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
        for (const folder of envPath.split(windows ? ';' : ':')) {
            const clean = folder.replace(/^"|"$/g, '');
            // Never discover an executable in the workspace through an empty or relative PATH entry.
            if (path.isAbsolute(clean)) await inspect(clean);
        }
        if (!pathOnly) {
            if (windows) {
                for (const programFiles of new Set([environment.ProgramFiles, environment['ProgramFiles(x86)']].filter(Boolean))) {
                    for (const root of await children(programFiles, /^gap(?:-|$)/i)) await installation(root);
                }
            } else {
                for (const root of ['/opt/gap', '/opt/homebrew/opt/gap', '/usr/local/opt/gap', '/usr/local', '/usr']) {
                    await installation(root);
                }
                for (const root of await children('/opt', /^gap(?:-|$)/i)) await installation(root);
                if (platform === 'darwin') {
                    for (const root of await children('/Applications', /^gap(?:[-.]|$)/i)) {
                        await installation(root);
                        await installation(path.join(root, 'Contents', 'Resources'));
                    }
                }
            }
        }
    }
    const values = [...candidates.values()].filter(candidate => !windows || ![...candidates.values()].some(other =>
        other.environmentDirectories.length === 2
        && path.dirname(path.dirname(other.environmentDirectories[1])).toLowerCase() === candidate.directory.toLowerCase()));
    return { status: values.length === 0 ? 'notFound' : values.length === 1 ? 'found' : 'ambiguous', candidates: values, issues };
}

module.exports = { findGap };
if (require.main === module) {
    const args = process.argv.slice(2);
    const directory = args[0] === '--directory' && args.length === 2 ? args[1] : undefined;
    if (args.length && !directory) {
        process.stdout.write(JSON.stringify({ status: 'error', code: 'INVALID_ARGUMENTS' }));
        process.exitCode = 1;
    } else {
        findGap({ directory }).then(result => process.stdout.write(JSON.stringify(result)), error => {
            process.stdout.write(JSON.stringify({ status: 'error', code: error.code || 'IO_ERROR' }));
            process.exitCode = 1;
        });
    }
}
