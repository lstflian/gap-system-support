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
    completionData: {
        generatedEmpty: 'generated data is empty',
        invalidFormat: 'invalid data format',
        generationAlreadyRunning: 'GAP: data generation is already running',
        generationFailed: 'GAP: data generation failed',
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
    },
} as const;
