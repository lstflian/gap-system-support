/**
 * Registration entry for the language model tools.
 */

import * as vscode from 'vscode';
import { Messages } from '../../shared/messages';
import type { ToolEntry, ToolRegistry } from '../contracts';
import { throwIfToolCancelled, ToolError } from '../core/toolCore';

/** A ToolError becomes the result text for the model; other errors fail the invocation. */
async function toolResult(run: () => unknown): Promise<vscode.LanguageModelToolResult> {
    let text: string;
    try {
        text = JSON.stringify(await run(), null, 2);
    } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        text = error.message;
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

export class LmToolsController implements vscode.Disposable {
    private registration: vscode.Disposable | undefined;
    private readonly listener: vscode.Disposable;
    private disposed = false;

    constructor(private readonly registry: ToolRegistry) {
        this.listener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gap.tools.enabled')) this.update();
        });
        try { this.update(); }
        catch (error) {
            this.listener.dispose();
            throw error;
        }
    }

    private update(): void {
        const enabled = vscode.workspace.getConfiguration('gap').get<boolean>('tools.enabled', true);
        if (enabled === !!this.registration || this.disposed) return;
        if (!enabled) {
            this.registration?.dispose();
            this.registration = undefined;
            return;
        }
        let active = true;
        const registrations: vscode.Disposable[] = [];
        const invocations = new Set<vscode.CancellationTokenSource>();
        const check = (token: vscode.CancellationToken): void => {
            if (!active || this.disposed
                || !vscode.workspace.getConfiguration('gap').get<boolean>('tools.enabled', true)) {
                throw new Error(Messages.tools.disabled);
            }
            throwIfToolCancelled(token);
        };
        try {
            this.registry.forEach(function register<I extends object, O extends object>({ metadata, tool }: ToolEntry<I, O>) {
                registrations.push(vscode.lm.registerTool<I>(metadata.name, {
                    async invoke(options, token) {
                        check(token);
                        const cancellation = new vscode.CancellationTokenSource();
                        const listener = token.onCancellationRequested(() => cancellation.cancel());
                        invocations.add(cancellation);
                        try {
                            const result = await toolResult(() => tool.execute(options.input, cancellation.token));
                            check(cancellation.token);
                            return result;
                        } finally {
                            listener.dispose();
                            invocations.delete(cancellation);
                            cancellation.dispose();
                        }
                    },
                    prepareInvocation(options, token) {
                        check(token);
                        return tool.prepare(options.input);
                    },
                }));
            });
        } catch (error) {
            active = false;
            vscode.Disposable.from(...registrations).dispose();
            throw error;
        }
        this.registration = new vscode.Disposable(() => {
            active = false;
            for (const invocation of invocations) invocation.cancel();
            vscode.Disposable.from(...registrations).dispose();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.listener.dispose();
        this.registration?.dispose();
        this.registration = undefined;
    }
}
