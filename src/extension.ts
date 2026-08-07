/**
 * GAP language support, extension entry point.
 */

import * as vscode from 'vscode';
import { initGapParser, onDocumentChanged, onDocumentClosed, disposeAll } from './parser/gapParser';
import { GAPSemanticTokensProvider, legend } from './semantic/semanticTokensProvider';
import { GAPFoldsProvider } from './folds/foldsProvider';
import { ensureData, generateData, resetData } from './completion/dataManager';
import { GapCompletionProvider } from './completion/completionProvider';
import { toShellPath } from './path';

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

    // Record content changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'gap') {
                onDocumentChanged(e.document.uri, e.contentChanges);
            }
        }),
    );

    // Register the document range semantic tokens provider.
    const highlightsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.scm').fsPath;
    const highlightsGlobalPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.global.scm').fsPath;
    const localsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'locals.scm').fsPath;

    const semanticProvider = new GAPSemanticTokensProvider(highlightsPath, localsPath, highlightsGlobalPath);
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeSemanticTokensProvider(
            { language: 'gap' },
            semanticProvider,
            legend,
        ),
    );

    // Handle document close events.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            onDocumentClosed(doc.uri);
            semanticProvider.onDocumentClosed(doc.uri);
        }),
    );

    // Register the folding range provider, driven by folds.scm.
    const foldsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'folds.scm').fsPath;
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider(
            { language: 'gap' },
            new GAPFoldsProvider(foldsPath),
        ),
    );

    // Register the completion provider, static data only.
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'gap' },
            new GapCompletionProvider(),
        ),
    );

    // Register the completion data commands.
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.generateCompletionData', () => generateData(context)),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('gap.resetCompletionData', () => resetData(context)),
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

    console.log('[GAP] extension activated, semantic highlighting and folding ready');
}

export function deactivate(): void {
    disposeAll();
}
