import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { GapError, reportError } from '../shared/errors';
import { Messages } from '../shared/messages';
import { notifyInfo, notifyWarning } from '../shared/notify';
import { Discovery, discoverGap, GapInstallation } from './discovery';

export { gapEnvironment } from './discovery';
export type { GapInstallation } from './discovery';

const STATE_KEY = `gap.runtime.selectedDirectory.${process.platform}.${os.hostname()}`;
let current: GapInstallationController | undefined;

export function initializeGapInstallation(context: vscode.ExtensionContext): GapInstallationController {
    current?.dispose();
    const controller = new GapInstallationController(context);
    current = controller;
    return controller;
}

export function resolveGapInstallation(interactive = false): Promise<GapInstallation | undefined> {
    return current ? current.resolve(interactive) : Promise.resolve(undefined);
}

export class GapInstallationController implements vscode.Disposable {
    private readonly abort = new AbortController();
    private pending: { selected?: string; environment: string; result: Promise<Discovery> } | undefined;
    private cache: { selected?: string; environment: string; value: GapInstallation } | undefined;
    private readonly command: vscode.Disposable;
    private readonly helpPrompts = new Set<string>();
    private readonly selectionChanged = new vscode.EventEmitter<void>();
    /** Fires after the user picks a different GAP installation in this window. */
    readonly onDidChangeSelection = this.selectionChanged.event;

    constructor(private readonly context: Pick<vscode.ExtensionContext, 'extensionUri' | 'globalState'>) {
        this.command = vscode.Disposable.from(
            vscode.commands.registerCommand('gap.selectInstallation', async () => {
                try { await this.select(); } catch (error) { await this.present(error); }
            }),
            vscode.commands.registerCommand('gap.detectInstallation', async () => {
                try {
                    this.cache = undefined;
                    const result = await this.detect();
                    const value = await this.choose(result);
                    if (!value && result.candidates.length) return;
                    if (value) {
                        await this.remember(value);
                        await this.offerHelpPaths(value);
                    } else if (await notifyWarning(Messages.runtime.notFound, Messages.runtime.selectFolder) === Messages.runtime.selectFolder) {
                        await this.select();
                    }
                } catch (error) { await this.present(error, true); }
            }),
        );
    }

    private async present(error: unknown, offerSelection = false): Promise<void> {
        if (error instanceof vscode.CancellationError || this.abort.signal.aborted) return;
        reportError(error, 'GAP runtime');
        const message = Messages.runtime.failed(error instanceof Error ? error.message : String(error));
        if (offerSelection) {
            if (await notifyWarning(message, Messages.runtime.selectFolder) === Messages.runtime.selectFolder) {
                try { await this.select(); } catch (selectionError) { await this.present(selectionError); }
            }
            return;
        }
        await vscode.window.showErrorMessage(message);
    }

    private detect(directory?: string): Promise<Discovery> {
        return discoverGap(this.context.extensionUri.fsPath, directory, this.abort.signal);
    }

    private async choose(result: Discovery): Promise<GapInstallation | undefined> {
        if (result.candidates.length === 1) return result.candidates[0];
        if (!result.candidates.length) return undefined;
        const item = await vscode.window.showQuickPick(result.candidates.map(candidate => ({
            label: candidate.executable, candidate,
        })), { placeHolder: Messages.runtime.chooseInstallation });
        return item?.candidate;
    }

    private async remember(value: GapInstallation): Promise<void> {
        const previous = this.selectedDirectory();
        await this.context.globalState.update(STATE_KEY, value.directory);
        this.cache = undefined;
        void notifyInfo(Messages.runtime.installationSelected(value.executable));
        if (previous !== value.directory) this.selectionChanged.fire();
    }

    /** The installation folder chosen explicitly by the user, if any. */
    selectedDirectory(): string | undefined {
        return this.context.globalState.get<string>(STATE_KEY);
    }

    /** Never make a GAP launch wait for the user to answer the doc/pkg prompt. */
    private offerHelpPathsInBackground(value: GapInstallation): void {
        void this.offerHelpPaths(value).catch(error => {
            if (!this.abort.signal.aborted) reportError(error, 'GAP runtime');
        });
    }

    private async offerHelpPaths(value: GapInstallation): Promise<void> {
        if (this.helpPrompts.has(value.directory)) return;
        this.helpPrompts.add(value.directory);
        const cfg = vscode.workspace.getConfiguration('gap');
        const missing = (['docPath', 'pkgPath'] as const).filter(key => !cfg.get<string>(key)?.trim() && value[key]);
        if (missing.length && await vscode.window.showInformationMessage(Messages.runtime.fillHelpPaths, Messages.runtime.usePaths) === Messages.runtime.usePaths) {
            for (const key of missing) {
                const currentConfig = vscode.workspace.getConfiguration('gap');
                if (!currentConfig.get<string>(key)?.trim()) {
                    const setting = currentConfig.inspect<string>(key);
                    const target = setting?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
                        : setting?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
                    await currentConfig.update(key, value[key], target);
                }
            }
        }
    }

    private async select(waitForPrompt = true): Promise<GapInstallation | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: Messages.runtime.selectFolder,
        });
        if (!picked?.length) return undefined;
        let result: Discovery;
        try { result = await this.detect(picked[0].fsPath); }
        catch (error) {
            reportError(error, 'GAP runtime');
            if (await notifyWarning(Messages.runtime.failed(error instanceof Error ? error.message : String(error)),
                Messages.runtime.selectFolder) === Messages.runtime.selectFolder) return this.select(waitForPrompt);
            return undefined;
        }
        const value = await this.choose(result);
        if (!value && result.candidates.length) return undefined;
        if (!value) {
            if (await notifyWarning(Messages.runtime.notFound, Messages.runtime.selectFolder) === Messages.runtime.selectFolder) {
                return this.select(waitForPrompt);
            }
            return undefined;
        }
        await this.remember(value);
        if (waitForPrompt) await this.offerHelpPaths(value);
        else this.offerHelpPathsInBackground(value);
        return value;
    }

    async resolve(interactive = false): Promise<GapInstallation> {
        if (this.abort.signal.aborted) throw new vscode.CancellationError();
        const selected = this.context.globalState.get<string>(STATE_KEY);
        const environment = JSON.stringify([process.platform, vscode.env.remoteName, vscode.env.shell,
            Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1]]);
        const cached = this.cache;
        if (cached && cached.selected === selected && cached.environment === environment) {
            try {
                const files = await Promise.all([fs.stat(cached.value.executable),
                    ...cached.value.environmentDirectories.map(directory => fs.stat(directory))]);
                if (this.abort.signal.aborted) throw new vscode.CancellationError();
                if (this.cache !== cached || this.context.globalState.get<string>(STATE_KEY) !== selected) return this.resolve(interactive);
                if (files[0].isFile() && files.slice(1).every(stat => stat.isDirectory())) {
                    if (interactive) this.offerHelpPathsInBackground(cached.value);
                    return cached.value;
                }
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)))) throw error;
            }
            this.cache = undefined;
        }
        if (!this.pending || this.pending.selected !== selected || this.pending.environment !== environment) {
            const pending = {
                selected, environment,
                result: this.detect(selected).finally(() => { if (this.pending === pending) this.pending = undefined; }),
            };
            this.pending = pending;
        }
        let result: Discovery;
        try { result = await this.pending.result; }
        catch (error) {
            if (!interactive || this.abort.signal.aborted) throw error;
            reportError(error, 'GAP runtime');
            if (await notifyWarning(Messages.runtime.failed(error instanceof Error ? error.message : String(error)),
                Messages.runtime.selectFolder) === Messages.runtime.selectFolder) {
                const value = await this.select(false);
                if (value) return value;
            }
            throw new vscode.CancellationError();
        }
        if (this.abort.signal.aborted) throw new vscode.CancellationError();
        if (this.context.globalState.get<string>(STATE_KEY) !== selected) return this.resolve(interactive);
        let value = result.candidates.length === 1 ? result.candidates[0] : undefined;
        if (!value && interactive) {
            if (result.candidates.length > 1) {
                value = await this.choose(result);
                if (value) await this.remember(value);
            } else if (await notifyWarning(Messages.runtime.notFound, Messages.runtime.selectFolder) === Messages.runtime.selectFolder) {
                value = await this.select(false);
            }
        }
        if (!value && interactive) throw new vscode.CancellationError();
        if (!value) throw new GapError('GAP_INSTALLATION_REQUIRED', result.candidates.length > 1
            ? Messages.runtime.ambiguous : Messages.runtime.notFound);
        if (interactive) this.offerHelpPathsInBackground(value);
        this.cache = { selected: this.context.globalState.get<string>(STATE_KEY), environment, value };
        return value;
    }

    dispose(): void {
        this.abort.abort();
        this.command.dispose();
        this.selectionChanged.dispose();
        this.cache = undefined;
        if (current === this) current = undefined;
    }
}
