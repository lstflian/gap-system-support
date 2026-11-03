import * as vscode from 'vscode';
import type { GapInstallationController } from '../runtime/installation';
import { reportError } from '../shared/errors';
import { getErrorMessage, Messages } from '../shared/messages';
import { notifyError } from '../shared/notify';
import type { ToolRegistry } from './contracts';
import { McpController } from './mcp';
import { LmToolsController } from './native';
import { createWindowToolRegistry } from './native/host';

export class ToolsController implements vscode.Disposable {
    private readonly registry: ToolRegistry;
    private native: LmToolsController | undefined;
    private mcp: McpController | undefined;
    private closing: Promise<void> | undefined;

    constructor(context: vscode.ExtensionContext, installation?: GapInstallationController) {
        this.registry = createWindowToolRegistry(context);
        for (const initialize of [
            () => { this.native = new LmToolsController(this.registry); },
            () => { this.mcp = new McpController(context, installation); },
        ]) {
            try { initialize(); }
            catch (error) {
                reportError(error, 'GAP tools');
                void notifyError(Messages.tools.initializationFailed(getErrorMessage(error)));
            }
        }
    }

    close(): Promise<void> {
        return this.closing ??= (async () => {
            this.native?.dispose();
            this.mcp?.dispose();
            await this.registry.close();
        })();
    }

    dispose(): void { void this.close().catch(error => reportError(error, 'GAP tools')); }
}
