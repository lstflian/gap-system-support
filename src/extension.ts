import * as vscode from 'vscode';
import { initializeGapFeatures } from './editor/activation';
import { registerGapCommands } from './editor/commands';
import { disposeAll } from './language/parser/gapParser';
import type { GapInstallationController } from './runtime/installation';
import { initializeGapInstallation } from './runtime/installation';
import { reportError, setErrorReporter } from './shared/errors';
import { Failures, getErrorMessage, Messages } from './shared/messages';
import { notifyError } from './shared/notify';
import { ToolsController } from './tools';

let languageActivation: Promise<boolean> | undefined;
let shuttingDown = false;
let tools: ToolsController | undefined;
let installation: GapInstallationController | undefined;

export async function activate(context: vscode.ExtensionContext) {
    shuttingDown = false;
    languageActivation = undefined;
    const output = vscode.window.createOutputChannel('GAP', { log: true });
    setErrorReporter(message => output.error(message));
    installation = initializeGapInstallation(context);
    context.subscriptions.push(output, { dispose: () => setErrorReporter(undefined) }, installation);
    try {
        tools = new ToolsController(context, installation);
        context.subscriptions.push(tools);
    } catch (error) {
        reportError(error, 'GAP tools');
        void notifyError(Messages.tools.initializationFailed(getErrorMessage(error)));
    }
    const ensureGapFeatures = (): Promise<boolean> => {
        if (shuttingDown) return Promise.resolve(false);
        languageActivation ??= initializeGapFeatures(context, () => shuttingDown).catch(error => {
            reportError(error, Failures.languageFeatureInitializationFailed);
            void notifyError(Messages.extension.activationFailed(getErrorMessage(error)));
            return false;
        });
        return languageActivation;
    };
    registerGapCommands(context, ensureGapFeatures);
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId === 'gap') void ensureGapFeatures();
    }));
    if (vscode.workspace.textDocuments.some(document => document.languageId === 'gap')) {
        await ensureGapFeatures();
    }
}

export async function deactivate(): Promise<void> {
    shuttingDown = true;
    installation?.dispose();
    try {
        await tools?.close();
        await languageActivation;
    } finally {
        disposeAll();
        tools = undefined;
        installation = undefined;
    }
}
