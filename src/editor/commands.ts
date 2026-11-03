import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    backupHelpIndexData,
    commitHelpIndexData,
    EXPORT_GAPDOC_TIMEOUT_MS,
    EXPORT_TEXT_TIMEOUT_MS,
    getHelpDataDir,
    getHelpState,
    reloadHelpIndex,
    restoreHelpIndexData
} from '../help/helpData';
import { showHelpPanel } from '../help/helpPanel';
import { searchHelp } from '../help/searchEngine';
import { showLiveSearchPicker } from '../help/searchPicker';
import { getRunCwd, resolveHelpPath, shellCdCommand, toShellPath } from '../path';
import { prepareGapTerminal } from '../runtime/terminal';
import { reportError } from '../shared/errors';
import { onErrorAsync, tryValue, tryValueAsync } from '../shared/guarded';
import { getErrorMessage, Messages } from '../shared/messages';
import { notifyError, notifyInfo, notifyWarning } from '../shared/notify';
import { waitTerminalClose } from '../shared/terminal';
import { generateData, resetData } from './completion/dataManager';

interface GAPFlag {
    flag: string;
    description: string;
}

const GAP_FLAGS: GAPFlag[] = [
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
let lastRunEnvironment: string | undefined;
// Guard against concurrent help index rebuilds.
let rebuildHelpRunning = false;

function getSelectedWord(): string | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sel = ed.selection;
    const range = sel.isEmpty ? ed.document.getWordRangeAtPosition(sel.start) : sel;
    return range ? ed.document.getText(range) : undefined;
}

/**
 * Read the doc and pkg paths from the settings.
 * Warn and open the settings for a path that is unset, not absolute, or missing.
 * Return null when either path is not usable.
 */
function getHelpPaths(): { docPath: string; pkgPath: string } | null {
    const cfg = vscode.workspace.getConfiguration('gap');
    const docPath = (cfg.get<string>('docPath') || '').trim();
    if (!docPath || !path.isAbsolute(docPath) || !fs.existsSync(docPath)) {
        notifyWarning(Messages.extension.docPathMissing, 'Open Settings').then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gap.docPath');
            }
        });
        return null;
    }
    const pkgPath = (cfg.get<string>('pkgPath') || '').trim();
    if (!pkgPath || !path.isAbsolute(pkgPath) || !fs.existsSync(pkgPath)) {
        notifyWarning(Messages.extension.pkgPathMissing, 'Open Settings').then(action => {
            if (action === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'gap.pkgPath');
            }
        });
        return null;
    }
    return { docPath, pkgPath };
}

function runConvertScript(scriptPath: string, dataDir: string): void {
    const { status, error, stderr: errorOutput, stdout: output } = spawnSync(
        process.execPath,
        [scriptPath],
        { cwd: dataDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    );
    if (error) {
        throw new Error(Messages.extension.convertScriptFailed(getErrorMessage(error)));
    }
    // Forward the converted counts, matching the old in-process console output.
    if (output) console.log(`[GAP] ${output.trim()}`);
    if (status !== 0) {
        throw new Error(Messages.extension.convertScriptStatusFailed(status, (errorOutput || output).trim()));
    }
}

/**
 * Run an export script in a hidden terminal.
 * Exit the shell after the script.
 * Resolve once the terminal closes.
 */
async function runExportScript(scriptUri: vscode.Uri, dataDir: string, timeoutMs: number): Promise<void> {
    const scriptPath = toShellPath(scriptUri.fsPath, scriptUri);
    if (!scriptPath) {
        throw new Error(Messages.extension.unsafeShellPath(scriptUri.fsPath));
    }
    const launch = await prepareGapTerminal();
    const terminal = vscode.window.createTerminal({
        name: 'GAP Help Index',
        cwd: dataDir,
        hideFromUser: true,
        env: launch.env,
    });
    try {
        await tryValueAsync(async () => {
            // Register the close listener, then send the command.
            const closed = waitTerminalClose(terminal, timeoutMs);
            terminal.sendText(`${launch.command} -q --nointeract ${scriptPath}`);
            terminal.sendText('exit');
            await closed;
        }, () => {
            throw new Error(
                Messages.extension.exportScriptTimeout(path.basename(scriptUri.fsPath), Math.round(timeoutMs / 1000))
            );
        });
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

    const item = vscode.window.createStatusBarItem(
        'gap.rebuildHelpIndex', vscode.StatusBarAlignment.Left, 100);
    item.text = '$(sync~spin) GAP: rebuilding help index…';
    item.show();
    try {
        await onErrorAsync(async () => {
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
                throw new Error(Messages.extension.missingIndexFiles(missing.join(', ')));
            }
            const state = reloadHelpIndex();
            if (!state.entries.length) {
                throw new Error(Messages.extension.helpIndexEmpty);
            }
            commitHelpIndexData();
            notifyInfo(Messages.extension.helpIndexRebuilt);
        }, () => {
            // Remove partial export files and restore the backups.
            restoreHelpIndexData();
        });
    } finally {
        item.dispose();
    }
}

export function registerGapCommands(
    context: vscode.ExtensionContext,
    ensureGapFeatures: () => Promise<boolean>,
): void {
    function registerCommand<A extends unknown[]>(
        name: string,
        callback: (...args: A) => unknown,
    ): vscode.Disposable {
        return vscode.commands.registerCommand(name, async (...args: A) => {
            try {
                if (await ensureGapFeatures()) return await callback(...args);
            } catch (error) {
                if (error instanceof vscode.CancellationError) return;
                reportError(error);
                await notifyError(getErrorMessage(error));
            }
        });
    }

    context.subscriptions.push(
        registerCommand('gap.generateCompletionData', () => generateData(context)),
    );
    context.subscriptions.push(
        registerCommand('gap.resetCompletionData', () => resetData(context)),
    );

    /**
     * Open the help QuickPick seeded with `seed`.
     * Shared by the search command and by command links inside hovers.
     */
    const openHelpSearch = async (seed: string): Promise<void> => {
        const paths = getHelpPaths();
        if (!paths) return;
        const state = tryValue(
            () => getHelpState(),
            (e: any) => {
                notifyError(Messages.extension.helpIndexLoadFailed(getErrorMessage(e)));
                return null;
            },
        );
        if (!state) return;
        const helpEntries = state.entries;
        const books = state.bookDescriptions;
        if (!helpEntries.length) {
            notifyWarning(Messages.extension.helpIndexNotLoaded);
            return;
        }

        const cfg = vscode.workspace.getConfiguration('gap');
        const fromBegin = cfg.get<string>('searchMode') === 'prefix';

        const picked = await showLiveSearchPicker(seed,
            (topic, fb) => searchHelp(helpEntries, topic, fb),
            fromBegin, books);
        if (!picked) return;

        showHelpPanel(picked, paths.docPath, paths.pkgPath);
    };

    // Live search through the GAP help index.
    context.subscriptions.push(
        registerCommand('gap.searchHelp', () => openHelpSearch(getSelectedWord() || '')),
    );
    // Internal command behind hover links: search a term from an argument.
    context.subscriptions.push(
        registerCommand('gap.searchHelpTerm', (term: string) => openHelpSearch(term || '')),
    );
    // Internal command behind the Go to Definition hover link.
    context.subscriptions.push(
        registerCommand('gap.goToDefinition', async (filePath: string, row: number) => {
            await tryValueAsync(async () => {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
                const editor = await vscode.window.showTextDocument(doc);
                const position = new vscode.Position(row, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }, (e: any) => {
                notifyError(Messages.extension.openDefinitionFailed(getErrorMessage(e)));
            });
        }),
    );

    context.subscriptions.push(
        registerCommand('gap.openReference', () => {
            const paths = getHelpPaths();
            if (!paths) return;
            const file = resolveHelpPath('/doc/ref/chap0.html', paths.docPath, paths.pkgPath);
            if (!file || !fs.existsSync(file)) {
                notifyWarning(Messages.extension.referenceManualMissing);
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

    context.subscriptions.push(
        registerCommand('gap.openReadme', () => {
            vscode.env.openExternal(vscode.Uri.parse(
                'https://github.com/lstflian/gap-system-support/blob/main/README.md'));
        }),
    );

    context.subscriptions.push(
        registerCommand('gap.openDocPathSetting', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gap.docPath');
        }),
        registerCommand('gap.openPkgPathSetting', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gap.pkgPath');
        }),
    );

    // Rebuild the help index with the local GAP.
    context.subscriptions.push(
        registerCommand('gap.rebuildHelpIndex', async () => {
            if (rebuildHelpRunning) {
                notifyInfo(Messages.extension.rebuildAlreadyRunning);
                return;
            }
            const yes = await notifyInfo(Messages.extension.rebuildConfirm, 'Rebuild');
            if (yes !== 'Rebuild') return;
            rebuildHelpRunning = true;
            try {
                await tryValueAsync(
                    () => doRebuildHelpIndex(context),
                    (e: any) => {
                        notifyError(Messages.extension.rebuildFailed(getErrorMessage(e)));
                    },
                );
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

    context.subscriptions.push(
        registerCommand('gap.configureFlags', async () => {
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
        registerCommand('gap.runFile', async (uri?: vscode.Uri) => {
            // Use the URI passed by the menu.
            // Otherwise use the active editor.
            const doc = uri
                ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
                : vscode.window.activeTextEditor?.document;
            if (!doc) return;

            if (doc.languageId !== 'gap') {
                notifyWarning(Messages.extension.runFileOnlyGap);
                return;
            }

            if (doc.isUntitled) {
                notifyWarning(Messages.extension.runFileSaveFirst);
                return;
            }

            if (doc.isDirty) {
                const saved = await doc.save();
                if (!saved) return;
            }

            const config = vscode.workspace.getConfiguration('gap');
            const runMode = config.get<string>('runMode', 'reuse') === 'reuse' ? 'reuse' : 'new';

            const runArguments = getSelectedFlags(context);

            const filePath = toShellPath(doc.uri.fsPath, doc.uri);
            if (!filePath) {
                notifyWarning(Messages.extension.runFileUnsafePath(doc.uri.fsPath));
                return;
            }
            const launch = await prepareGapTerminal();
            const command = `${launch.command} ${runArguments.join(' ')} ${filePath}`.trim();

            const cwd = getRunCwd(doc.uri);
            const cwdKey = cwd?.toString();

            if (runMode === 'reuse' && runTerminal && lastRunEnvironment === launch.key) {
                // Change to the file's root when it differs from the last run.
                if (cwd && cwdKey !== lastRunRoot) {
                    const cwdPath = toShellPath(cwd.fsPath, cwd);
                    if (!cwdPath) {
                        notifyWarning(Messages.extension.runFileUnsafePath(cwd.fsPath));
                        return;
                    }
                    runTerminal.sendText(`${shellCdCommand()} ${cwdPath}`);
                    lastRunRoot = cwdKey;
                }
                runTerminal.sendText(command);
                runTerminal.show();
            } else {
                const name = runMode === 'reuse'
                    ? 'GAP'
                    : `GAP: ${doc.fileName.split(/[/\\]/).pop()}`;
                // Stop cmd from running a gap.bat or gap.exe found in the workspace folder.
                const env = launch.env;
                const terminal = vscode.window.createTerminal(
                    cwd ? { name, cwd, env } : { name, env }
                );

                terminal.show();
                if (runMode === 'reuse') {
                    runTerminal = terminal;
                    lastRunRoot = cwdKey;
                    lastRunEnvironment = launch.key;
                }
                terminal.sendText(command);
            }
        })
    );

}
