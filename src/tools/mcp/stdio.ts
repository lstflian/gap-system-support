/**
 * Standalone MCP server over stdio. VS Code, or any MCP client, starts this script with Node.js;
 * it never listens on a port and never loads the vscode module.
 */

import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CancellationSource, isCancellationError } from '../../shared/cancellation';
import { reportError, setErrorReporter } from '../../shared/errors';
import { Failures, getErrorMessage } from '../../shared/messages';
import type { ToolEntry, ToolRegistry } from '../contracts';
import { ToolError } from '../core/toolCore';
import { createToolRegistry } from '../registry';
import { createStandaloneToolHost, settingsFromEnvironment } from './environment';

export function createGapMcpServer(registry: ToolRegistry, invocations: Set<CancellationSource>): McpServer {
    const server = new McpServer({ name: 'gap-system-support', version: registry.version });
    registry.forEach(function register<I extends object, O extends object>({ metadata, tool, annotations }: ToolEntry<I, O>) {
        server.registerTool(metadata.name, {
            title: metadata.displayName,
            description: metadata.modelDescription,
            inputSchema: fromJsonSchema<I>(metadata.inputSchema),
            annotations,
        }, async (input, context) => {
            const cancellation = new CancellationSource();
            const cancel = (): void => cancellation.cancel();
            const signal = context.mcpReq.signal;
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            invocations.add(cancellation);
            try {
                const output = await tool.execute(input, cancellation.token);
                return { content: [], structuredContent: output };
            } catch (error) {
                if (!(error instanceof ToolError) && !isCancellationError(error)) {
                    reportError(error, Failures.failed(metadata.name));
                }
                return { content: [{ type: 'text', text: getErrorMessage(error) }], isError: true };
            } finally {
                signal.removeEventListener('abort', cancel);
                invocations.delete(cancellation);
                cancellation.dispose();
            }
        });
    });
    return server;
}

function main(): void {
    // stdout carries the protocol; every diagnostic goes to stderr.
    const log = (...args: unknown[]): void => { console.error(...args); };
    console.log = console.info = console.debug = console.warn = log;
    setErrorReporter(message => { process.stderr.write(message + '\n'); });
    const extensionRoot = path.resolve(__dirname, '..', '..', '..');
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
    const registry = createToolRegistry(manifest, createStandaloneToolHost(extensionRoot, settingsFromEnvironment(process.env)));
    const invocations = new Set<CancellationSource>();
    const connection = serveStdio(() => createGapMcpServer(registry, invocations), {
        onerror: error => reportError(error, Failures.protocolError),
    });
    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        for (const invocation of invocations) invocation.cancel();
        // Wait until cancelled GAP process trees are gone before exiting.
        void Promise.allSettled([connection.close(), registry.close()]).finally(() => process.exit(0));
    };
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}

if (require.main === module) main();
