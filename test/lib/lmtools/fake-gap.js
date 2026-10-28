'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const bootstrap = fs.readFileSync(0, 'utf8');
const ready = bootstrap.match(/^Print\("(GAP_RUN_READY_[a-f0-9]{32})"\);\n$/)?.[1];
if (args[1] !== '*stdin*' || !ready) throw new Error('Missing GAP startup bootstrap');
const source = fs.readFileSync(args[2], 'utf8');
const settings = JSON.parse(source.match(/^# runner: (.+)$/m)?.[1] || '{}');
if (settings.startupExitCode !== undefined) {
    process.stdout.write('launcher output before startup\n');
    process.stderr.write('launcher failed before GAP started\n', () => process.exit(settings.startupExitCode));
} else if (settings.startupHang) {
    process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }) + '\n');
    process.stdout.write('waiting for GAP startup\n'.repeat(8));
    setInterval(() => {}, 1000);
} else {
    start().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}

async function start() {
    if (settings.banner) process.stdout.write(settings.banner);
    if (settings.splitReady) {
        for (const byte of ready) {
            process.stdout.write(byte);
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    } else {
        process.stdout.write(ready);
    }
    const child = settings.spawnChild
        ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        : undefined;
    process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, childPid: child?.pid }) + '\n');
    process.stdout.write(settings.stdout ?? 'stdout\n');
    process.stderr.write(settings.stderr ?? 'stderr\n');
    if (settings.bytes) process.stdout.write('x'.repeat(settings.bytes));

    function finish() {
        process.stdout.write('finished\n', () => process.exit(settings.exitCode || 0));
    }

    if (settings.waitFile) {
        const timer = setInterval(() => {
            if (fs.existsSync(settings.waitFile)) {
                clearInterval(timer);
                finish();
            }
        }, 20);
    } else if (settings.hang) {
        setInterval(() => {}, 1000);
    } else {
        finish();
    }
}
