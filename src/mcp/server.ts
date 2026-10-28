import * as http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as vscode from 'vscode';
import {
    createMcpHandler, fromJsonSchema, McpServer, isInitializeRequest, isLegacyRequest,
    WebStandardStreamableHTTPServerTransport, type McpHandlerRequestOptions,
} from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { ToolEntry, ToolRegistry } from '../lmtools/registry';
import { ToolError, throwIfToolCancelled } from '../lmtools/toolCore';
import { getErrorMessage, Messages } from '../shared/messages';
import { MCP_MAX_REQUEST_BYTES, MCP_MAX_LEGACY_SESSIONS, MCP_LEGACY_SESSION_IDLE_MS } from '../limits';
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
    const completions = new Set<Promise<void>>();
    const requestSignals = new AsyncLocalStorage<AbortSignal>();
    interface LegacyState {
        invocations: Set<vscode.CancellationTokenSource>;
        lastUsed: number;
    }
    interface LegacySession extends LegacyState {
        id?: string;
        server: McpServer;
        transport: WebStandardStreamableHTTPServerTransport;
        closing?: Promise<void>;
    }
    const sessions = new Map<string, LegacySession>();
    const legacyServers = new Set<LegacySession>();
    const requests = new Set<Promise<Response>>();
    const authorization = `Bearer ${token}`;
    const expectedAuthorization = Buffer.from(authorization);
    const createServer = (legacy?: LegacyState, statelessLegacy = false): McpServer => {
        const mcp = new McpServer({ name: 'gap-system-support', version: registry.version });
        registry.forEach(function register<I extends object, O extends object>({ metadata, tool, annotations }: ToolEntry<I, O>) {
            mcp.registerTool(metadata.name, {
                title: metadata.displayName,
                description: metadata.modelDescription,
                inputSchema: fromJsonSchema<I>(metadata.inputSchema),
                annotations: annotations ?? {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            }, async (input, context) => {
                const cancellation = new vscode.CancellationTokenSource();
                const cancel = (): void => cancellation.cancel();
                const signals = [context.mcpReq.signal, requestSignals.getStore()];
                for (const signal of signals) {
                    signal?.addEventListener('abort', cancel, { once: true });
                    if (signal?.aborted) cancel();
                }
                invocations.add(cancellation);
                legacy?.invocations.add(cancellation);
                let finish!: () => void;
                const completion = new Promise<void>(resolve => { finish = resolve; });
                completions.add(completion);
                try {
                    if (!accepting || !isEnabled()) throw new ToolError(Messages.mcp.stopped);
                    if (statelessLegacy && metadata.name === 'run_gap_file') throw new ToolError(Messages.mcp.runNeedsSession);
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
                    for (const signal of signals) signal?.removeEventListener('abort', cancel);
                    invocations.delete(cancellation);
                    if (legacy) {
                        legacy.invocations.delete(cancellation);
                        legacy.lastUsed = Date.now();
                    }
                    cancellation.dispose();
                    completions.delete(completion);
                    finish();
                }
            });
        });
        return mcp;
    };
    const handler = createMcpHandler(context => createServer(undefined, context.era === 'legacy'), {
        legacy: 'stateless',
        maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
        onerror: error => console.error('[GAP MCP] protocol error:', error),
    });
    const closeSession = (session: LegacySession): Promise<void> => {
        session.closing ??= (async () => {
            if (session.id) sessions.delete(session.id);
            for (const invocation of session.invocations) invocation.cancel();
            await session.server.close();
            legacyServers.delete(session);
        })();
        return session.closing;
    };
    const errorResponse = (status: number, message: string): Response =>
        Response.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, { status });
    const route = async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
        if (!accepting || !isEnabled()) return errorResponse(503, Messages.mcp.stopped);
        let body = options?.parsedBody;
        if (request.method === 'POST' && body === undefined) {
            try {
                body = await request.clone().json();
            } catch (error) {
                if (error instanceof SyntaxError) return handler.fetch(request, options);
                throw error;
            }
        }
        const parsed = { ...options, parsedBody: body };
        if (!await isLegacyRequest(request, body)) return handler.fetch(request, parsed);
        const id = request.headers.get('mcp-session-id');
        if (id) {
            const session = sessions.get(id);
            if (!session) return errorResponse(404, Messages.mcp.sessionMissing);
            session.lastUsed = Date.now();
            return session.transport.handleRequest(request, parsed);
        }
        if (request.method !== 'POST' || !isInitializeRequest(body)) return handler.fetch(request, parsed);
        // Stateless legacy notifications cannot cancel another POST. Give each initialized client its own transport.
        await Promise.all([...legacyServers].filter(session =>
            session.invocations.size === 0 && Date.now() - session.lastUsed > MCP_LEGACY_SESSION_IDLE_MS).map(closeSession));
        if (!accepting || !isEnabled()) return errorResponse(503, Messages.mcp.stopped);
        if (legacyServers.size >= MCP_MAX_LEGACY_SESSIONS) return errorResponse(503, Messages.mcp.sessionCapacity);
        const state: LegacyState = { invocations: new Set(), lastUsed: Date.now() };
        const mcp = createServer(state);
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: sessionId => {
                session.id = sessionId;
                if (accepting && isEnabled()) sessions.set(sessionId, session);
            },
            onsessionclosed: () => closeSession(session),
        });
        const session: LegacySession = Object.assign(state, { server: mcp, transport });
        legacyServers.add(session);
        try {
            await mcp.connect(transport);
            if (!accepting || !isEnabled()) return errorResponse(503, Messages.mcp.stopped);
            return await transport.handleRequest(request, parsed);
        } finally {
            if (!session.id || !accepting || !isEnabled()) await closeSession(session);
        }
    };
    const nodeHandler = toNodeHandler({
        fetch: (request, options) => requestSignals.run(request.signal, () => {
            const pending = route(request, options);
            requests.add(pending);
            void pending.then(() => requests.delete(pending), () => requests.delete(pending));
            return pending;
        }),
    }, {
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
        closing = (async () => {
            await Promise.all([httpClosed, handler.close(), ...[...legacyServers].map(closeSession)]);
            await Promise.all([...requests]);
            await Promise.all([...completions]);
        })();
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
