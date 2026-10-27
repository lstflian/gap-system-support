/**
 * Centralized message texts.
 * All user-visible messages and internal throws are defined here.
 * Keep the rendered texts identical to the original output.
 * Dynamic parts are parameters of message factory functions.
 */

/** Safely extract a human-readable message from an unknown error value. */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return String(err);
}

/** Reason text for a path that the terminal quotes cannot protect. */
function unsafeShellPath(file: string): string {
    return `the path contains a character that the terminal would interpret (" “ ” „ $ \` ! % or a control character), rename it and try again: ${file}`;
}

/** All message texts, grouped by feature. */
export const Messages = {
    parser: {
        languageNotLoaded: 'GAP language is not loaded. Call initGapParser() first.',
        parserNotInitialized: 'GAP parser is not initialized. Call initGapParser() first.',
    },
    terminal: {
        timeout: 'timeout',
    },
    loader: {
        failedToLoad: (name: string, reason: string) => `GAP: Failed to load ${name}: ${reason}`,
    },
    tools: {
        disabled: 'GAP: Native language model tools are disabled.',
        invalidManifest: 'GAP: The tool definitions in the extension manifest are invalid or do not match the implementations.',
    },
    mcp: {
        disabled: 'GAP: Enable "gap.mcp.enabled" to use the MCP server.',
        untrusted: 'GAP: The MCP server is unavailable until this workspace is trusted.',
        startFailed: (reason: string) => `GAP: Failed to start the MCP server: ${reason}`,
        stopFailed: (reason: string) => `GAP: Failed to stop the MCP server: ${reason}`,
        serverFailed: (reason: string) => `GAP: The MCP server failed: ${reason}`,
        unavailable: 'GAP: The MCP server is unavailable. Check the extension log, then toggle "gap.mcp.enabled" to retry.',
        configurationCopied: 'GAP: MCP connection configuration copied. It contains a private access token.',
        copyFailed: (reason: string) => `GAP: Failed to copy MCP connection configuration: ${reason}`,
        invalidCredentialStorage: 'GAP: The saved MCP credential is invalid. Run "GAP: Reset MCP Access Token" to replace it.',
        tokenReset: 'GAP: MCP access token reset for this VS Code profile. Previous credentials no longer authorize its servers; copy updated connection configuration for external clients.',
        resetTokenFailed: (reason: string) => `GAP: Failed to reset the MCP access token: ${reason}`,
        requestFailed: 'GAP: The MCP request could not be completed.',
        stopped: 'GAP: The MCP server has stopped.',
        invalidPort: 'GAP: "gap.mcp.port" must be an integer between 0 and 65535; use 0 for automatic port allocation.',
        portInUse: (port: number) =>
            `MCP port ${port} is already in use. Choose another "gap.mcp.port" or use 0 for automatic port allocation.`,
    },
    completionData: {
        generatedEmpty: 'generated data is empty',
        invalidFormat: 'invalid data format',
        generationAlreadyRunning: 'GAP: data generation is already running',
        generationFailed: 'GAP: data generation failed',
        generationUnsafePath: (file: string) =>
            `GAP: data generation failed, ${unsafeShellPath(file)}`,
        generationDone: (count: number) => `GAP: completion data generated (${count} functions)`,
        generationRunningWait: 'GAP: data generation is running, please wait',
        resetCompleted: 'GAP: reset completed',
        resetFailed: 'GAP: reset failed',
    },
    semantic: {
        definitionScopeMissing: 'definition scope is missing from the global index',
    },
    helpWebview: {
        fileNotFound: (file: string) => `GAP: File not found: ${file}`,
        renderFailed: (reason: string) => `GAP: ${reason}`,
    },
    extension: {
        docPathMissing: 'GAP: Please set "gap.docPath" to the doc/ folder of your GAP installation.',
        pkgPathMissing: 'GAP: Please set "gap.pkgPath" to the pkg/ folder of your GAP installation.',
        parserLoadFailed: 'GAP: failed to load the tree-sitter-gap parser. Check that wasm/tree-sitter-gap.wasm exists.',
        activationFailed: (reason: string) => `GAP: Failed to initialize language features: ${reason}`,
        convertScriptFailed: (reason: string) => `failed to run convert_export.js: ${reason}`,
        convertScriptStatusFailed: (status: number | null, output: string) =>
            `convert_export.js failed with status ${status}: ${output}`,
        exportScriptTimeout: (name: string, seconds: number) =>
            `${name} did not complete within ${seconds} seconds`,
        missingIndexFiles: (names: string) => `missing index files: ${names}`,
        helpIndexEmpty: 'parsed help index is empty',
        helpIndexRebuilt: 'GAP: help index rebuilt',
        helpIndexLoadFailed: (reason: string) => `GAP: failed to load help index: ${reason}`,
        helpIndexNotLoaded: 'GAP: Help index not loaded. Try running "GAP: Rebuild Help Index".',
        openDefinitionFailed: (reason: string) => `GAP: failed to open definition: ${reason}`,
        referenceManualMissing: 'GAP: Reference manual not found in this installation.',
        rebuildAlreadyRunning: 'GAP: help index rebuild is already running',
        rebuildConfirm: 'GAP: Clear cached help index and rebuild?',
        rebuildFailed: (reason: string) => `GAP: rebuild help index failed: ${reason}`,
        runFileOnlyGap: 'GAP: this command only works on GAP files.',
        runFileSaveFirst: 'GAP: please save the file before running.',
        runFileUnsafePath: (file: string) => `GAP: cannot run the file, ${unsafeShellPath(file)}`,
        unsafeShellPath: (file: string) => unsafeShellPath(file),
    },
} as const;
