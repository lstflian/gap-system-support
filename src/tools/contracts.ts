/**
 * Contracts shared by the native language model tools and the standalone MCP server.
 * Nothing here loads the vscode module at runtime.
 */

import type { CancellationToken } from 'vscode';
import type { HelpDataContext } from '../help/helpData';
import type { TextSnapshot } from '../language/documents';
import type { RunEnvironment } from '../runtime/contracts';

export interface ToolMetadata {
    /** The single identifier used as tool name, reference name, display name and MCP tool name. */
    name: string;
    displayName: string;
    modelDescription: string;
    inputSchema: { type: 'object'; [key: string]: unknown };
}

export interface ToolAnnotations {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
}

export interface PreparedInvocation {
    invocationMessage: string;
    confirmationMessages?: { title: string; message: string };
}

export interface GapTool<I extends object, O extends object> {
    execute(input: I, token: CancellationToken): O | Promise<O>;
    prepare(input: I): PreparedInvocation;
}

export interface HelpSettings {
    docPath: string;
    pkgPath: string;
    searchMode: string;
}

/** Everything a tool needs from the process that hosts it. */
export interface ToolHost {
    /** Locates wasm/, the bundled data and the writable copy of the help index. */
    readonly location: HelpDataContext;
    /** True when a VS Code window may rebuild the help index while this host keeps it loaded. */
    readonly sharedHelpIndex: boolean;
    helpSettings(): HelpSettings;
    /** The open editor buffer for filePath, so unsaved text is checked. */
    openDocument(filePath: string): TextSnapshot | undefined;
    isTrusted(): boolean;
    /** Save unsaved editor changes to filePath so GAP runs what the user sees. */
    saveSource(filePath: string, token: CancellationToken): Promise<void>;
    /** Working directory when the caller does not choose one. */
    defaultCwd(filePath: string): string;
    runEnvironment(): RunEnvironment;
}

export interface ToolEntry<I extends object, O extends object> {
    metadata: ToolMetadata;
    annotations: ToolAnnotations;
    tool: GapTool<I, O>;
}

export interface ToolRegistry {
    readonly version: string;
    forEach(visitor: <I extends object, O extends object>(entry: ToolEntry<I, O>) => void): void;
    dispose(): void;
    close(): Promise<void>;
}
