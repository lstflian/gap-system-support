import * as vscode from 'vscode';
import type { ToolRegistry } from '../lmtools/registry';
import type { RunningMcpServer } from './server';
import { getErrorMessage, Messages } from '../shared/messages';
import { notifyError, notifyInfo, notifyWarning } from '../shared/notify';
import { tryValueAsync } from '../shared/guarded';
import { McpCredentials } from './credentials';
import { MCP_CREDENTIAL_CHECK_INTERVAL_MS } from '../limits';

export class McpController implements vscode.Disposable {
    private server: RunningMcpServer | undefined;
    private registration: vscode.Disposable | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly listeners: vscode.Disposable;
    private pending = Promise.resolve();
    private desired = false;
    private desiredPort = 0;
    private generation = 0;
    private disposed = false;
    private readonly credentials: McpCredentials;
    private credentialKey: string | undefined;
    private credentialRefreshPending = false;
    private readonly credentialMonitor: ReturnType<typeof setInterval>;

    constructor(
        private readonly registry: ToolRegistry,
        context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>,
    ) {
        this.credentials = new McpCredentials(context);
        this.listeners = vscode.Disposable.from(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('gap.mcp.enabled') || event.affectsConfiguration('gap.mcp.port')) {
                    this.update();
                }
            }),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.update()),
            context.secrets.onDidChange(event => {
                if (this.credentials.handlesChange(event.key)) this.credentialChanged();
            }),
            vscode.commands.registerCommand('gap.copyMcpConfiguration', () => this.copyConfiguration()),
            vscode.commands.registerCommand('gap.resetMcpToken', () => this.resetToken()),
        );
        this.credentialMonitor = setInterval(() => this.checkCredential(), MCP_CREDENTIAL_CHECK_INTERVAL_MS);
        this.credentialMonitor.unref();
        this.update();
    }

    private isEnabled(): boolean {
        return !this.disposed && vscode.workspace.isTrusted
            && vscode.workspace.getConfiguration('gap').get<boolean>('mcp.enabled', false);
    }

    private notify(show: () => Thenable<unknown>): void {
        void tryValueAsync(async () => { await show(); }, error => {
            if (!(error instanceof vscode.CancellationError)) {
                console.error('[GAP MCP] notification failed:', error);
            }
        });
    }

    private withdraw(): void {
        this.registration?.dispose();
        this.registration = undefined;
        this.changed.fire();
    }

    private async closeServer(): Promise<void> {
        const server = this.server;
        if (!server) return;
        await server.close();
        if (this.server === server) {
            this.server = undefined;
            this.credentialKey = undefined;
        }
    }

    private checkCredential(): void {
        if (this.registration && this.server && this.credentialKey && !this.credentials.isCurrent(this.credentialKey)) {
            this.credentialChanged();
        }
    }

    private credentialChanged(): void {
        if (!this.isEnabled() || this.credentialRefreshPending) return;
        this.credentialRefreshPending = true;
        const generation = this.generation;
        this.pending = this.pending.then(async () => {
            if (!this.isEnabled() || generation !== this.generation) return;
            const { key, token } = await this.credentials.getCredential();
            if (this.isEnabled() && generation === this.generation
                && (this.credentialKey !== key || this.server?.authorization !== `Bearer ${token}`)) {
                this.update(true);
            }
        }).catch(error => this.serverFailed(error, generation)).finally(() => {
            this.credentialRefreshPending = false;
        });
    }

    private update(force = false): void {
        const desired = this.isEnabled();
        const port = vscode.workspace.getConfiguration('gap').get<number>('mcp.port', 0);
        if (!force && desired === this.desired && (!desired || port === this.desiredPort)) return;
        this.desired = desired;
        this.desiredPort = port;
        const generation = ++this.generation;
        this.withdraw();
        this.server?.stopAccepting();
        this.pending = this.pending.then(async () => {
            if (generation !== this.generation) return;
            await this.closeServer();
            if (!this.isEnabled() || generation !== this.generation) return;
            const { key, token } = await this.credentials.getCredential();
            if (!this.isEnabled() || generation !== this.generation) return;
            const { startMcpServer } = await import('./server');
            if (!this.isEnabled() || generation !== this.generation) return;
            const isCurrent = (): boolean => {
                if (!this.isEnabled() || generation !== this.generation) return false;
                if (this.credentials.isCurrent(key)) return true;
                this.credentialChanged();
                return false;
            };
            const server = await startMcpServer(this.registry, isCurrent,
                error => this.serverFailed(error, generation), token, port);
            let published = false;
            try {
                if (!isCurrent()) return;
                const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
                    onDidChangeMcpServerDefinitions: this.changed.event,
                    // Agent hosts can project this definition without calling resolve.
                    provideMcpServerDefinitions: () => isCurrent() && this.server === server
                        ? [new vscode.McpHttpServerDefinition('GAP', vscode.Uri.parse(server.url),
                            { Authorization: server.authorization }, this.registry.version)]
                        : [],
                    resolveMcpServerDefinition: (definition, token) => {
                        if (token.isCancellationRequested || !isCurrent() || this.server !== server) return;
                        definition.uri = vscode.Uri.parse(server.url);
                        definition.headers = { Authorization: server.authorization };
                        return definition;
                    },
                };
                this.registration = vscode.lm.registerMcpServerDefinitionProvider('gap.mcp', provider);
                this.server = server;
                this.credentialKey = key;
                published = true;
                this.changed.fire();
            } finally {
                if (!published) await server.close();
            }
        }).catch(error => {
            console.error('[GAP MCP] lifecycle failed:', error);
            this.notify(() => notifyError(desired
                ? Messages.mcp.startFailed(getErrorMessage(error))
                : Messages.mcp.stopFailed(getErrorMessage(error))));
        });
    }

    private serverFailed(error: Error, generation: number): void {
        if (generation !== this.generation) return;
        this.generation++;
        this.withdraw();
        this.server?.stopAccepting();
        this.pending = this.pending.then(() => this.closeServer()).catch(closeError => {
            console.error('[GAP MCP] shutdown failed:', closeError);
            this.notify(() => notifyError(Messages.mcp.stopFailed(getErrorMessage(closeError))));
        });
        console.error('[GAP MCP] server failed:', error);
        this.notify(() => notifyError(Messages.mcp.serverFailed(getErrorMessage(error))));
    }

    private async copyConfiguration(): Promise<void> {
        if (!vscode.workspace.getConfiguration('gap').get<boolean>('mcp.enabled', false)) {
            this.notify(() => notifyWarning(Messages.mcp.disabled));
            return;
        }
        if (!vscode.workspace.isTrusted) {
            this.notify(() => notifyWarning(Messages.mcp.untrusted));
            return;
        }
        try {
            this.update();
            await this.whenIdle();
            if (!this.isEnabled() || !this.server) {
                this.notify(() => notifyError(Messages.mcp.unavailable));
                return;
            }
            await vscode.env.clipboard.writeText(JSON.stringify({
                type: 'http',
                url: this.server.url,
                headers: { Authorization: this.server.authorization },
            }, null, 2));
        } catch (error) {
            console.error('[GAP MCP] copy configuration failed:', error);
            this.notify(() => notifyError(Messages.mcp.copyFailed(getErrorMessage(error))));
            return;
        }
        this.notify(() => notifyInfo(Messages.mcp.configurationCopied));
    }

    private async resetToken(): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            this.notify(() => notifyWarning(Messages.mcp.untrusted));
            return;
        }
        try {
            await this.credentials.resetToken();
            this.update(true);
            await this.whenIdle();
        } catch (error) {
            console.error('[GAP MCP] token reset failed:', error);
            this.notify(() => notifyError(Messages.mcp.resetTokenFailed(getErrorMessage(error))));
            return;
        }
        this.notify(() => notifyInfo(Messages.mcp.tokenReset));
    }

    async whenIdle(): Promise<void> {
        let pending: Promise<void>;
        do {
            this.checkCredential();
            pending = this.pending;
            await pending;
            this.checkCredential();
        } while (pending !== this.pending);
    }

    stop(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            this.desired = false;
            this.generation++;
            this.listeners.dispose();
            clearInterval(this.credentialMonitor);
            this.withdraw();
            this.changed.dispose();
            this.server?.stopAccepting();
            this.pending = this.pending.then(() => this.closeServer());
        }
        return this.pending;
    }

    dispose(): void {
        void this.stop().catch(error => {
            console.error('[GAP MCP] shutdown failed:', error);
            this.notify(() => notifyError(Messages.mcp.stopFailed(getErrorMessage(error))));
        });
    }
}
