import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as vscode from 'vscode';
import { createMcpHandler, fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { ToolEntry, ToolRegistry } from '../lmtools/registry';
import { ToolError, throwIfToolCancelled } from '../lmtools/toolCore';
import { getErrorMessage, Messages } from '../shared/messages';
import { MCP_MAX_REQUEST_BYTES } from '../limits';
import { isMcpToken } from './credentials';

export interface RunningMcpServer {
    readonly url: string;
    readonly authorization: string;
    stopAccepting(): void;
    close(): Promise<void>;
}

export async function startMcpServer(
    registry: ToolRegistry,
    isEnabled: () => boolean,
    onError: (error: Error) => void,
    token: string,
    port = 0,
): Promise<RunningMcpServer> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(Messages.mcp.invalidPort);
    if (!isMcpToken(token)) throw new Error(Messages.mcp.invalidCredentialStorage);
    let accepting = true;
    const invocations = new Set<vscode.CancellationTokenSource>();
    const authorization = `Bearer ${token}`;
    const expectedAuthorization = Buffer.from(authorization);
    const handler = createMcpHandler(() => {
        const mcp = new McpServer({ name: 'gap-system-support', version: registry.version });
        registry.forEach(function register<I extends object, O extends object>({ metadata, tool }: ToolEntry<I, O>) {
            mcp.registerTool(metadata.name, {
                title: metadata.displayName,
                description: metadata.modelDescription,
                inputSchema: fromJsonSchema<I>(metadata.inputSchema),
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            }, async (input, context) => {
                const cancellation = new vscode.CancellationTokenSource();
                const cancel = (): void => cancellation.cancel();
                const signal = context.mcpReq.signal;
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted) cancel();
                invocations.add(cancellation);
                try {
                    if (!accepting || !isEnabled()) throw new ToolError(Messages.mcp.stopped);
                    throwIfToolCancelled(cancellation.token);
                    const output = await tool.execute(input, cancellation.token);
                    throwIfToolCancelled(cancellation.token);
                    if (!accepting || !isEnabled()) throw new ToolError(Messages.mcp.stopped);
                    return {
                        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                        structuredContent: { ...output },
                    };
                } catch (error) {
                    if (!(error instanceof ToolError) && !cancellation.token.isCancellationRequested) {
                        console.error(`[GAP MCP] ${metadata.name} failed:`, error);
                    }
                    return { content: [{ type: 'text', text: getErrorMessage(error) }], isError: true };
                } finally {
                    signal.removeEventListener('abort', cancel);
                    invocations.delete(cancellation);
                    cancellation.dispose();
                }
            });
        });
        return mcp;
    }, {
        legacy: 'stateless',
        maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
        onerror: error => console.error('[GAP MCP] protocol error:', error),
    });
    const nodeHandler = toNodeHandler(handler, {
        maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
        onerror: error => console.error('[GAP MCP] HTTP adapter error:', error),
    });
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const server = http.createServer((request, response) => {
        if (!validateHost(request, response) || !validateOrigin(request, response)) return;
        if (request.url !== '/mcp') {
            response.writeHead(404).end();
            return;
        }
        if (!accepting || !isEnabled()) {
            response.writeHead(503).end(Messages.mcp.stopped);
            return;
        }
        const supplied = Buffer.from(request.headers.authorization ?? '');
        if (supplied.length !== expectedAuthorization.length
            || !timingSafeEqual(supplied, expectedAuthorization)) {
            response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="GAP MCP"', Connection: 'close' }).end();
            return;
        }
        // Reject known oversized bodies before the adapter consumes and aborts their socket.
        if (Number(request.headers['content-length']) > MCP_MAX_REQUEST_BYTES) {
            response.writeHead(413, { Connection: 'close' }).end();
            return;
        }
        void nodeHandler(request, response).catch(error => {
            console.error('[GAP MCP] HTTP request failed:', error);
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined);
            } else {
                response.writeHead(500).end(Messages.mcp.requestFailed);
            }
        });
    });
    const stopAccepting = (): void => {
        accepting = false;
        for (const invocation of invocations) invocation.cancel();
        server.closeAllConnections();
    };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closing) return closing;
        stopAccepting();
        const httpClosed = server.listening
            ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
            : Promise.resolve();
        server.closeAllConnections();
        closing = Promise.all([httpClosed, handler.close()]).then(() => undefined);
        return closing;
    };
    try {
        await new Promise<void>((resolve, reject) => {
            const failed = (error: Error): void => reject(error);
            server.once('error', failed);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', failed);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error(Messages.mcp.unavailable);
        server.on('error', error => {
            stopAccepting();
            onError(error);
        });
        return { url: `http://127.0.0.1:${address.port}/mcp`, authorization, stopAccepting, close };
    } catch (error) {
        await close();
        if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
            throw new Error(Messages.mcp.portInUse(port), { cause: error });
        }
        throw error;
    }
}
