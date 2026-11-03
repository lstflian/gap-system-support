/**
 * Publishes the stdio MCP server through VS Code's MCP server definition provider API.
 * VS Code starts and stops the server process; there is no port, listener or access token.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GapInstallationController } from '../../runtime/installation';
import { defaultWindowsProfileArgs } from '../../runtime/terminal';
import { reportError } from '../../shared/errors';
import { Failures, getErrorMessage, Messages } from '../../shared/messages';
import { notifyError, notifyInfo, notifyWarning } from '../../shared/notify';
import { settingsToEnvironment } from './environment';

export const MCP_PROVIDER_ID = 'gap.mcp';

/** Settings that change the server's environment; VS Code restarts the server when they change. */
const RELEVANT_SETTINGS = [
    'gap.mcp.enabled', 'gap.docPath', 'gap.pkgPath', 'gap.searchMode', 'gap.terminalRoot',
    'terminal.integrated.defaultProfile.windows', 'terminal.integrated.profiles.windows',
];

type McpContext = Pick<vscode.ExtensionContext, 'extension' | 'globalStorageUri' | 'globalState' | 'secrets'>;

export interface McpLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export class McpController implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly disposables: vscode.Disposable[];
    private readonly cleanup: Promise<void>;

    constructor(private readonly context: McpContext, private readonly installation?: GapInstallationController) {
        const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
            onDidChangeMcpServerDefinitions: this.changed.event,
            // Agent hosts may use this definition without calling resolve, so it is complete here.
            provideMcpServerDefinitions: () => this.isEnabled() ? [this.definition()] : [],
            resolveMcpServerDefinition: definition => this.isEnabled() ? definition : undefined,
        };
        const fire = (): void => this.changed.fire();
        this.disposables = [
            vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (RELEVANT_SETTINGS.some(key => event.affectsConfiguration(key))) fire();
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(fire),
            vscode.workspace.onDidChangeWorkspaceFolders(fire),
            vscode.env.onDidChangeShell(fire),
            ...(installation ? [installation.onDidChangeSelection(fire)] : []),
            vscode.commands.registerCommand('gap.copyMcpConfiguration', () => this.copyConfiguration()),
            this.changed,
        ];
        this.cleanup = removeLegacyMcpState(context).catch(error => reportError(error, Failures.legacyCleanupFailed));
    }

    private isEnabled(): boolean {
        return vscode.workspace.isTrusted && vscode.workspace.getConfiguration('gap').get<boolean>('mcp.enabled', false);
    }

    /** The command that starts the stdio server with this window's settings. */
    launch(): McpLaunch {
        const config = vscode.workspace.getConfiguration('gap');
        return {
            command: process.execPath,
            args: [path.join(__dirname, 'stdio.js')],
            env: {
                // process.execPath is the editor's Electron binary; run it as plain Node.js.
                ELECTRON_RUN_AS_NODE: '1',
                ...settingsToEnvironment({
                    storage: this.context.globalStorageUri.fsPath,
                    docPath: (config.get<string>('docPath') || '').trim(),
                    pkgPath: (config.get<string>('pkgPath') || '').trim(),
                    searchMode: config.get<string>('searchMode', 'prefix'),
                    shell: vscode.env.shell,
                    terminalRoot: config.get<string>('terminalRoot') ?? '',
                    wslProfileArgs: process.platform === 'win32' ? defaultWindowsProfileArgs() : undefined,
                    gapDirectory: this.installation?.selectedDirectory(),
                    workspaceRoots: (vscode.workspace.workspaceFolders ?? [])
                        .filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
                }),
            },
        };
    }

    private definition(): vscode.McpStdioServerDefinition {
        const { command, args, env } = this.launch();
        const version = String((this.context.extension.packageJSON as { version?: unknown }).version ?? '');
        return new vscode.McpStdioServerDefinition('GAP', command, args, { ...env, NODE_OPTIONS: null }, version);
    }

    private async copyConfiguration(): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            void notifyWarning(Messages.mcp.untrusted);
            return;
        }
        try {
            const { command, args, env } = this.launch();
            await vscode.env.clipboard.writeText(JSON.stringify({ type: 'stdio', command, args, env }, null, 2));
        } catch (error) {
            reportError(error, Failures.copyConfigurationFailed);
            void notifyError(Messages.mcp.copyFailed(getErrorMessage(error)));
            return;
        }
        void notifyInfo(Messages.mcp.configurationCopied);
    }

    /** Resolves once the one-time removal of the old HTTP service's state has finished. */
    whenIdle(): Promise<void> {
        return this.cleanup;
    }

    dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose();
    }
}

const LEGACY_STATE_KEYS = ['gap.mcp.tokenKey', 'gap.mcp.credentialRevision', 'gap.mcp.instanceId', 'gap.mcp.scopeNotice'];
const LEGACY_SECRET_PREFIX = 'gap.mcp.token.';

/** Remove the access tokens, state and broker folders of the former HTTP MCP service. */
async function removeLegacyMcpState(context: McpContext): Promise<void> {
    const storage = context.globalStorageUri.fsPath;
    const instanceId = context.globalState.get<unknown>('gap.mcp.instanceId');
    const tasks: Promise<unknown>[] = [];
    for (const key of LEGACY_STATE_KEYS) {
        if (context.globalState.get<unknown>(key) !== undefined) tasks.push(Promise.resolve(context.globalState.update(key, undefined)));
    }
    tasks.push(Promise.resolve(context.secrets.keys()).then(keys => Promise.all(keys
        .filter(key => key.startsWith(LEGACY_SECRET_PREFIX))
        .map(key => context.secrets.delete(key)))));
    if (process.platform === 'win32') {
        tasks.push(fs.rm(path.join(storage, 'mcp'), { recursive: true, force: true }));
    } else if (typeof instanceId === 'string') {
        tasks.push(fs.realpath(storage).then(canonical => {
            const hash = createHash('sha256').update(canonical + '\0' + instanceId).digest('hex').slice(0, 32);
            const name = `gap-mcp-${process.getuid?.() ?? 'user'}-${hash}`;
            return Promise.all([os.tmpdir(), '/tmp'].map(folder =>
                fs.rm(path.join(folder, name), { recursive: true, force: true })));
        }, () => undefined));
    }
    for (const result of await Promise.allSettled(tasks)) {
        if (result.status === 'rejected') reportError(result.reason, Failures.legacyCleanupFailed);
    }
}
