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

export const Messages = {
    runtime: {
        notFound: 'GAP: No usable GAP installation was found. Run "GAP: Select GAP Installation" to choose its folder.',
        ambiguous: 'GAP: Multiple GAP installations were found. Run "GAP: Select GAP Installation" to choose one.',
        selectFolder: 'Select GAP Folder',
        chooseInstallation: 'Select the GAP installation to use',
        installationSelected: (executable: string) => `GAP: Using executable: ${executable}`,
        discoveryFailed: 'GAP installation discovery failed. Check the GAP output log and select the installation folder.',
        invalidDiscovery: 'GAP installation discovery returned an invalid response.',
        discoveryIssue: (code: string, file: string) => `GAP discovery: ${code}: ${file}`,
        failed: (reason: string) => `GAP: ${reason}`,
        fillHelpPaths: 'GAP: Use the detected doc/pkg folders for settings that are currently empty?',
        usePaths: 'Use Detected Folders',
    },
    common: {
        canceled: 'Canceled',
    },
    diagnostics: {
        missing: (token: string) => `Missing "${token}"`,
        unexpected: (snippet: string) => `Unexpected syntax: ${snippet}`,
    },
    parser: {
        languageNotLoaded: 'GAP language is not loaded. Call initGapParser() first.',
        parserNotInitialized: 'GAP parser is not initialized. Call initGapParser() first.',
        parseFailed: 'GAP parser did not produce a syntax tree.',
    },
    terminal: {
        timeout: 'timeout',
    },
    loader: {
        failedToLoad: (name: string, reason: string) => `GAP: Failed to load ${name}: ${reason}`,
    },
    tools: {
        initializationFailed: (reason: string) => `GAP: Could not initialize tools: ${reason}`,
        helpConfigurationMissing: 'gap.docPath and gap.pkgPath are not configured. Please set these two settings to the doc/ and pkg/ folders ' +
            'of your GAP installation. See the README of the gap-system-support extension (in your VS Code extensions ' +
            'folder: ~/.vscode/extensions/flianlee.gap-system-support-<version>/README.md).',
        unknownBooks: (names: string) => `Unknown book name(s): ${names}. Call gapListBooks to get the valid book names.`,
        disabled: 'GAP: Native language model tools are disabled.',
        invalidManifest: 'GAP: The tool definitions in the extension manifest are invalid or do not match the implementations.',
        runUntrusted: 'GAP: Running GAP files requires a trusted workspace.',
        runClosed: 'GAP: The GAP file runner has stopped.',
        runPathRequired: (name: string) => `${name} must be a non-empty absolute file path without null characters.`,
        runInputNotFile: 'GAP: filePath must refer to a readable file.',
        runCwdRequired: 'GAP: cwd must be an absolute directory path without null characters.',
        runCwdNotDirectory: 'GAP: cwd must refer to an existing directory.',
        runOutputNotFile: 'GAP: outputPath must refer to a file, not a directory or another special file.',
        runSameFile: 'GAP: outputPath must not refer to the GAP source file.',
        runOutputBusy: 'GAP: Another invocation is already writing to outputPath.',
        runSaveFailed: (file: string) => `GAP: Could not save the modified document: ${file}`,
        runSourceChanged: (file: string) =>
            `GAP: filePath no longer refers to the saved document after saving. Retry with the document's path: ${file}`,
        runNotFound: 'GAP: Could not find an executable GAP launcher. Run "GAP: Select GAP Installation" to choose its folder.',
        runLauncherFailed: 'GAP: GAP did not confirm startup. Check the output file for launcher errors, then run "GAP: Select GAP Installation".',
        runShellLauncherFailed: 'GAP: GAP did not confirm startup. Check the output file for launcher errors and make sure `gap` is on the PATH ' +
            'of the interactive shell in the WSL distribution used as the VS Code terminal; "GAP: Select GAP Installation" does not apply to WSL.',
        runInvalidProtocol: 'GAP: The shell returned an invalid GAP launcher response.',
        runInvalidShellArgs: 'GAP: The selected WSL terminal profile must use an argument array without an embedded command.',
        runWslCancelFailed: 'GAP: Could not obtain the WSL process group to confirm cancellation.',
        runInterrupted: (signal: string) => `GAP: The GAP process was interrupted (${signal}); it did not finish normally.`,
        runFailed: (reason: string) => `GAP: Could not run the GAP file: ${reason}`,
        runInvocation: (file: string, output: string) => `Running GAP file '${file}' with output redirected to '${output}'`,
        runConfirmationTitle: 'Run GAP file and overwrite output?',
        runConfirmation: (file: string, output: string, cwd?: string) =>
            `Save any unsaved changes to '${file}', execute it with GAP -q --nointeract (quiet mode), ` +
            `and overwrite '${output}'. ` +
            (cwd === undefined ? "Use the file's workspace root as cwd, if any. " : `Use '${cwd}' as cwd. `) +
            'GAP code can modify files and perform other actions. There is no fixed runtime limit; cancel to stop it. ' +
            'You can read the output file while it runs. Completion does not mean the GAP program succeeded.',
    },
    mcp: {
        untrusted: 'GAP: The MCP server is unavailable until this workspace is trusted.',
        configurationCopied: 'GAP: MCP server configuration copied. It starts the GAP MCP server over stdio with your current settings; ' +
            'copy it again after updating the extension or changing GAP settings.',
        copyFailed: (reason: string) => `GAP: Failed to copy the MCP server configuration: ${reason}`,
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

export const Failures = {
    completionDataLoadFailed: '[GAP] completion data load failed: ',
    helpIndexEnsureFailed: '[GAP] help index ensure failed: ',
    languageFeatureInitializationFailed: '[GAP] language feature initialization failed:',
    parserInitializationFailed: '[GAP] parser initialization failed: ',
    filepathIsRequiredAndMustBeANonEmpty: 'filePath is required and must be a non-empty string.',
    filepathMustBeAnAbsolutePath: 'filePath must be an absolute path.',
    theGapHelpIndexIsEmptyTryGapRebuild: 'The GAP help index is empty. Try "GAP: Rebuild Help Index" first.',
    relativepathIsRequiredAndMustBeANonEmpty: 'relativePath is required and must be a non-empty string.',
    failedToRead: (file: string, reason: string) => `Failed to read ${file}: ${reason}`,
    topicIsRequiredAndMustBeANonEmpty: 'topic is required and must be a non-empty string.',
    invalidModeUsePrefixOrSubstring: 'Invalid mode. Use "prefix" or "substring".',
    invalidRangeUseA1BasedInclusiveRangeLike: 'Invalid range. Use a 1-based inclusive range like [1, 20] with 1 <= start <= end.',
    unknownHelpFilePathForEntry: (file: string, entry: string) => `Unknown help file path: ${file} for entry '${entry}'.`,
    theGapParserIsNotReadyYetTryAgain: 'The GAP parser is not ready yet; try again later.',
    canceled: 'Canceled',
    copyConfigurationFailed: '[GAP MCP] copy configuration failed:',
    legacyCleanupFailed: '[GAP MCP] removing the former HTTP service state failed:',
    failed: (tool: string) => `[GAP MCP] ${tool} failed:`,
    protocolError: '[GAP MCP] protocol error:',
} as const;
