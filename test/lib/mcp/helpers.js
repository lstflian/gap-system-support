'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

function toolOutput(result) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(result.content, [], 'MCP success results omit the serialized JSON text fallback');
    assert(result.structuredContent && typeof result.structuredContent === 'object'
        && !Array.isArray(result.structuredContent), 'MCP tools return structured object results');
    return result.structuredContent;
}

/** VS Code removes variables whose value is null; a spawned process only accepts strings. */
function stringEnvironment(env) {
    return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== null).map(([key, value]) => [key, String(value)]));
}

/** Start the server exactly as VS Code would from a stdio definition. */
async function connect(launch, { modern = false } = {}) {
    const transport = new StdioClientTransport({
        command: launch.command, args: launch.args, env: stringEnvironment(launch.env), stderr: 'pipe',
    });
    const stderr = [];
    transport.stderr?.on('data', chunk => stderr.push(chunk.toString()));
    const client = new Client({ name: 'gap-stdio-test', version: '1' }, modern ? { versionNegotiation: { mode: 'auto' } } : undefined);
    await client.connect(transport);
    return { client, transport, stderr };
}

async function waitFor(predicate, message, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
        assert(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function log(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        if (process.platform === 'linux' && fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z ')) {
            return false;
        }
        return true;
    } catch (error) {
        if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
        throw error;
    }
}

/** The fake GAP launcher writes its pid and arguments as the first JSON line of the output. */
async function record(file, running = false) {
    const metadata = () => log(file).split('\n').find(line => line.startsWith('{"args":'));
    await waitFor(() => {
        const line = metadata();
        return line?.endsWith('}') && (!running || alive(JSON.parse(line).pid));
    }, `No live output at ${file}`);
    return JSON.parse(metadata());
}

async function stopped(info) {
    await waitFor(() => !alive(info.pid) && (!info.childPid || !alive(info.childPid)), 'Invocation left a running process');
}

/** A GAP source whose `# runner:` line configures test/lib/lmtools/fake-gap.js. */
function source(file, settings = {}) {
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    fs.writeFileSync(file, `# runner: ${JSON.stringify(settings)}\nx := 1;\n`);
}

module.exports = { toolOutput, stringEnvironment, connect, waitFor, log, alive, record, stopped, source };
