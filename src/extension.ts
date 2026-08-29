/**
 * GAP language support, extension entry point.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { initGapParser, onDocumentChanged, onDocumentClosed, disposeAll } from './parser/gapParser';
import { GAPSemanticTokensProvider, legend } from './semantic/semanticTokensProvider';
import { GAPFoldsProvider } from './folds/foldsProvider';
import { GAPDiagnosticsProvider } from './diagnostics/diagnosticsProvider';
import { ensureData, generateData, resetData } from './completion/dataManager';
import { GapCompletionProvider } from './completion/completionProvider';
import { toShellPath, resolveHelpPath } from './path';
import { searchHelp } from './help/searchEngine';
import { HelpEntry } from './help/indexData';
import { showLiveSearchPicker } from './help/searchPicker';
import { showHelpPanel, refreshCurrentPage } from './help/helpPanel';
import { initStyleState } from './help/styleState';
import {
    ensureHelpIndex,
    getHelpState,
    reloadHelpIndex,
    backupHelpIndexData,
    restoreHelpIndexData,
    commitHelpIndexData,
    getHelpDataDir,
    waitTerminalClose,
    EXPORT_GAPDOC_TIMEOUT_MS,
    EXPORT_TEXT_TIMEOUT_MS,
} from './help/helpData';

interface GapFlag {
    flag: string;
    description: string;
}

const GAP_FLAGS: GapFlag[] = [
    { flag: '-q', description: 'Enable or disable quiet mode' },
    { flag: '-b', description: 'Disable or enable the banner' },
    { flag: '-T', description: 'Disable or enable break loop and error traceback' },
    { flag: '--nointeract', description: 'Start GAP in non-interactive mode, which disables the REPL and break loop' },
    { flag: '--norepl', description: 'Disable the GAP read-evaluate-print loop (REPL)' },
    { flag: '--alwaystrace', description: 'Always print error traceback, which overrides the behaviour of -T' },
];

function getSelectedFlags(context: vscode.ExtensionContext): string[] {
    const saved = context.globalState.get<string[]>('gap.flags');
    if (saved === undefined) return [];
    return saved.filter(f => GAP_FLAGS.some(g => g.flag === f));
}

// The terminal is shared across run commands.
let runTerminal: vscode.Terminal | null = null;
// The root of the last run, compared against the current root.
let lastRunRoot: string | undefined;
// Guard against concurrent help index rebuilds.
let rebuildHelpRunning = false;

/** Get selected text under cursor. */
function getSelectedWord(): string | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sel = ed.selection;
    const range = sel.isEmpty ? ed.document.getWordRangeAtPosition(sel.start) : sel;
    return range ? ed.document.getText(range) : undefined;
}

/**
 * Read the doc and pkg paths from the configuration.
 * Warn and open the settings for a path that is unset, not absolute, or missing.
 * Return null when either path is not usable.
 */
function getHelpPaths(): { docPath: string; pkgPath: string } | null {
    const cfg = vscode.workspace.getConfiguration('gap');
    const docPath = (cfg.get<string>('docPath') || '').trim();
    if (!docPath || !path.isAbsolute(docPath) || !fs.existsSync(docPath)) {
        vscode.window.showWarningMessage(
            'GAP: Please set "gap.docPath" to the doc/ folder of your GAP installation.',
            'Open Settings'
        ).then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gap.docPath');
            }
        });
        return null;
    }
    const pkgPath = (cfg.get<string>('pkgPath') || '').trim();
    if (!pkgPath || !path.isAbsolute(pkgPath) || !fs.existsSync(pkgPath)) {
        vscode.window.showWarningMessage(
            'GAP: Please set "gap.pkgPath" to the pkg/ folder of your GAP installation.',
            'Open Settings'
        ).then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gap.pkgPath');
            }
        });
        return null;
    }
    return { docPath, pkgPath };
}

/** Run convert_export.js */
function runConvertScript(scriptPath: string, cwd: string): void {
    const prev = process.cwd();
    process.chdir(cwd);
    try {
        const p = require.resolve(scriptPath);
        if (p in require.cache) delete require.cache[p];
        require(p);
    } finally {
        process.chdir(prev);
    }
}

/**
 * Run an export script in a hidden terminal.
 * Exit the shell after the script.
 * Resolve once the terminal closes.
 */
async function runExportScript(scriptUri: vscode.Uri, dataDir: string, timeoutMs: number): Promise<void> {
    const terminal = vscode.window.createTerminal({
        name: 'GAP Help Index',
        cwd: dataDir,
        hideFromUser: true,
    });
    try {
        // Register the close listener, then send the command.
        const closed = waitTerminalClose(terminal, timeoutMs);
        terminal.sendText(`gap -q --nointeract ${toShellPath(scriptUri.fsPath, scriptUri)}`);
        terminal.sendText('exit');
        await closed;
    } catch (e: any) {
        throw new Error(`${path.basename(scriptUri.fsPath)} timed out`);
    } finally {
        terminal.dispose();
    }
}

/**
 * Rebuild the help index.
 * Run export.g, convert_export.js, then export_text.g.
 * Back up the current export files first.
 * Commit the backups on success, restore them on failure.
 */
async function doRebuildHelpIndex(context: vscode.ExtensionContext): Promise<void> {
    const dataDir = getHelpDataDir(context);
    fs.mkdirSync(dataDir, { recursive: true });

    const exportG = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'helpIndex', 'export.g');
    const exportText = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'helpIndex', 'export_text.g');
    const convert = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'helpIndex', 'convert_export.js');
    const products = ['export_gapdoc.txt', 'export_default.txt', 'export_text.txt'];

    // Show the rebuild progress on the status bar.
    const item = vscode.window.createStatusBarItem(
        'gap.rebuildHelpIndex', vscode.StatusBarAlignment.Left, 100);
    item.text = '$(sync~spin) GAP: rebuilding help index…';
    item.show();
    try {
        // Back up the current export files first.
        backupHelpIndexData();
        await runExportScript(exportG, dataDir, EXPORT_GAPDOC_TIMEOUT_MS);
        runConvertScript(convert.fsPath, dataDir);
        await runExportScript(exportText, dataDir, EXPORT_TEXT_TIMEOUT_MS);

        // Verify the three export files.
        // Load the new help index.
        // Reject an empty index.
        // Drop the backups after the load succeeds.
        const missing = products.filter(name => !fs.existsSync(path.join(dataDir, name)));
        if (missing.length) {
            throw new Error(`missing index files: ${missing.join(', ')}`);
        }
        const state = reloadHelpIndex();
        if (!state.entries.length) {
            throw new Error('parsed help index is empty');
        }
        commitHelpIndexData();
        vscode.window.showInformationMessage('GAP: help index rebuilt');
    } catch (err) {
        // Remove partial export files and restore the backups.
        restoreHelpIndexData();
        throw err;
    } finally {
        item.dispose();
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('[GAP] extension activate start');
    try {
        await initGapParser(context);
    } catch (err) {
        console.error('[GAP] parser initialization failed: ', err);
        vscode.window.showErrorMessage(
            'GAP: failed to load the tree-sitter-gap parser. Check that wasm/tree-sitter-gap.wasm exists.'
        );
        return;
    }

    try {
        ensureData(context);
    } catch (err) {
        console.error('[GAP] completion data load failed: ', err);
    }

    try {
        ensureHelpIndex(context);
    } catch (err) {
        console.error('[GAP] help index ensure failed: ', err);
    }

    initStyleState(context);

    // Re-render the open help page when the MathJax setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gap.mathJax')) {
                refreshCurrentPage();
            }
        })
    );

    // Publish tree-sitter syntax diagnostics (Problems panel, squiggles).
    const diagnosticsProvider = new GAPDiagnosticsProvider();
    context.subscriptions.push(diagnosticsProvider);

    // Record content changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'gap') {
                onDocumentChanged(e.document.uri, e.contentChanges);
                diagnosticsProvider.schedule(e.document);
            }
        }),
    );

    // Register the document range semantic tokens provider.
    const highlightsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.scm').fsPath;
    const highlightsGlobalPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.global.scm').fsPath;
    const localsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'locals.scm').fsPath;

    const semanticProvider = new GAPSemanticTokensProvider(
        highlightsPath,
        localsPath,
        highlightsGlobalPath,
        {
            globalIndexMode: 'enabled',
            contentLengthLimit: 2 * 1024 * 1024,
            maxGlobalCacheBytes: 256 * 1024 * 1024,
        },
    );
    context.subscriptions.push({ dispose: () => semanticProvider.dispose() });
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeSemanticTokensProvider(
            { language: 'gap' },
            semanticProvider,
            legend,
        ),
    );

    // Register the completion provider: static data scope aware completions.
    const completionPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'completion.scm').fsPath;
    const completionProvider = new GapCompletionProvider(completionPath);
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'gap' },
            completionProvider,
        ),
    );

    // Register the folding range provider, driven by folds.scm.
    const foldsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'folds.scm').fsPath;
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'gap' },
            new GAPFoldsProvider(foldsPath),
        ),
    );

    // Validate immediately when a document is opened or saved.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => diagnosticsProvider.checkNow(doc)),
    );
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => diagnosticsProvider.checkNow(doc)),
    );
    // Enable/disable diagnostics when the gap.diagnostics setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gap.diagnostics')) {
                diagnosticsProvider.onConfigurationChanged();
            }
        }),
    );

    // Handle document close events.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            onDocumentClosed(doc.uri);
            semanticProvider.onDocumentClosed(doc.uri);
            completionProvider.onDocumentClosed(doc.uri);
            diagnosticsProvider.onDocumentClosed(doc.uri);
        }),
    );

    // Register the completion data commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.generateCompletionData', () => generateData(context)),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.resetCompletionData', () => resetData(context)),
    );

    // Live search through the GAP help index.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.searchHelp', async () => {
            const paths = getHelpPaths();
            if (!paths) return;
            let helpEntries: HelpEntry[];
            let books: Map<string, string>;
            try {
                const state = getHelpState();
                helpEntries = state.entries;
                books = state.bookDescriptions;
            } catch (e: any) {
                vscode.window.showErrorMessage(`GAP: failed to load help index: ${e.message}`);
                return;
            }
            if (!helpEntries.length) {
                vscode.window.showWarningMessage('GAP: Help index not loaded. Try running "GAP: Rebuild Help Index".');
                return;
            }
            const seed = getSelectedWord() || '';

            const cfg = vscode.workspace.getConfiguration('gap');
            const fromBegin = cfg.get<string>('searchMode') === 'prefix';

            const picked = await showLiveSearchPicker(seed,
                (topic, fb) => searchHelp(helpEntries, topic, fb),
                fromBegin, books);
            if (!picked) return;

            showHelpPanel(picked, paths.docPath, paths.pkgPath);
        }),
    );

    // Open the GAP Reference Manual in the help panel.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.openReference', () => {
            const paths = getHelpPaths();
            if (!paths) return;
            const file = resolveHelpPath('/doc/ref/chap0.html', paths.docPath, paths.pkgPath);
            if (!file || !fs.existsSync(file)) {
                vscode.window.showWarningMessage('GAP: Reference manual not found in this installation.');
                return;
            }
            showHelpPanel({
                filePath: '/doc/ref/chap0.html',
                anchor: '',
                display: 'Reference Manual',
                key: '',
                book: 'Reference',
                isTextOnly: false,
                chapter: 0,
                section: 0,
                type: '',
            }, paths.docPath, paths.pkgPath);
        }),
    );

    // Open the README in the browser.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.openReadme', () => {
            vscode.env.openExternal(vscode.Uri.parse(
                'https://github.com/lstflian/gap-system-support/blob/main/README.md'));
        }),
    );

    // Open the doc/pkg path settings (used by the walkthrough buttons).
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.openDocPathSetting', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gap.docPath');
        }),
        vscode.commands.registerCommand('gap.openPkgPathSetting', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gap.pkgPath');
        }),
    );

    // Rebuild the help index with the local GAP.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.rebuildHelpIndex', async () => {
            if (rebuildHelpRunning) {
                vscode.window.showInformationMessage('GAP: help index rebuild is already running');
                return;
            }
            const yes = await vscode.window.showInformationMessage(
                'GAP: Clear cached help index and rebuild?', 'Rebuild');
            if (yes !== 'Rebuild') return;
            rebuildHelpRunning = true;
            try {
                await doRebuildHelpIndex(context);
            } catch (e: any) {
                vscode.window.showErrorMessage(`GAP: rebuild help index failed: ${e.message}`);
            } finally {
                rebuildHelpRunning = false;
            }
        }),
    );

    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((closed) => {
            if (closed === runTerminal) {
                runTerminal = null;
            }
        })
    );

    // Configure the GAP command line options.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.configureFlags', async () => {
            const currentFlags = getSelectedFlags(context);
            const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
            picker.canSelectMany = true;
            picker.placeholder = 'Select GAP command line options';
            const items = GAP_FLAGS.map(f => ({
                label: f.flag,
                description: f.description,
                picked: currentFlags.includes(f.flag),
            }));
            picker.items = items;
            // Copy the picked state into selectedItems.
            picker.selectedItems = items.filter(i => i.picked);
            picker.buttons = [
                { iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear selection' },
            ];
            picker.onDidTriggerButton(() => {
                picker.selectedItems = [];
            });
            picker.onDidAccept(() => {
                const flags = picker.selectedItems.map(p => p.label);
                context.globalState.update('gap.flags', flags);
                picker.dispose();
            });
            picker.show();
        })
    );

    // Run the current GAP file in a terminal.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.runFile', async (uri?: vscode.Uri) => {
            // Use the URI passed by the menu.
            // Otherwise use the active editor.
            const doc = uri
                ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
                : vscode.window.activeTextEditor?.document;
            if (!doc) return;

            if (doc.languageId !== 'gap') {
                vscode.window.showWarningMessage('GAP: this command only works on GAP files.');
                return;
            }

            if (doc.isUntitled) {
                vscode.window.showWarningMessage('GAP: please save the file before running.');
                return;
            }

            if (doc.isDirty) {
                const saved = await doc.save();
                if (!saved) return;
            }

            const config = vscode.workspace.getConfiguration('gap');
            const runMode = config.get<string>('runMode', 'reuse') === 'reuse' ? 'reuse' : 'new';

            const runArguments = getSelectedFlags(context);

            const command = `gap ${runArguments.join(' ')} ${toShellPath(doc.uri.fsPath, doc.uri)}`.trim();

            const cwd = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri;
            const cwdKey = cwd?.toString();

            if (runMode === 'reuse' && runTerminal) {
                // Change to the file's root when it differs from the last run.
                if (cwd && cwdKey !== lastRunRoot) {
                    runTerminal.sendText(`cd ${toShellPath(cwd.fsPath, cwd)}`);
                    lastRunRoot = cwdKey;
                }
                runTerminal.sendText(command);
                runTerminal.show();
            } else {
                const name = runMode === 'reuse'
                    ? 'GAP'
                    : `GAP: ${doc.fileName.split(/[/\\]/).pop()}`;
                const terminal = vscode.window.createTerminal(
                    cwd ? { name, cwd } : { name }
                );

                terminal.show();
                if (runMode === 'reuse') {
                    runTerminal = terminal;
                    lastRunRoot = cwdKey;
                }
                // Send the command to the terminal.
                terminal.sendText(command);
            }
        })
    );

    // Sweep GAP documents that were already open when the extension activated.
    for (const doc of vscode.workspace.textDocuments) {
        diagnosticsProvider.checkNow(doc);
    }

    console.log('[GAP] extension activated, semantic highlighting and folding ready');

    // Open the walkthrough once after the first install.
    if (!context.globalState.get<boolean>('gap.welcomeShown')) {
        context.globalState.update('gap.welcomeShown', true);
        vscode.commands.executeCommand(
            'workbench.action.openWalkthrough',
            'flianlee.gap-system-support#gap-support.gettingStarted',
        );
    }
}

export function deactivate(): void {
    disposeAll();
}
