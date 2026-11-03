import type { CancellationToken, Disposable } from 'vscode';
import { Messages } from './messages';

export type { CancellationToken };

/** Matches VS Code's cancellation error shape without loading the vscode module. */
export class CancellationError extends Error {
    constructor() {
        super(Messages.common.canceled);
        this.name = 'Canceled';
    }
}

export function isCancellationError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'Canceled' || error.name === 'CancellationError');
}

export function throwIfCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested) throw new CancellationError();
}

export class CancellationSource {
    private readonly listeners = new Set<() => void>();
    readonly token: CancellationToken;

    constructor() {
        this.token = {
            isCancellationRequested: false,
            onCancellationRequested: (listener, thisArg, disposables) => {
                const callback = (): void => { listener.call(thisArg, undefined); };
                const disposable: Disposable = { dispose: () => { this.listeners.delete(callback); } };
                if (this.token.isCancellationRequested) queueMicrotask(callback);
                else this.listeners.add(callback);
                disposables?.push(disposable);
                return disposable;
            },
        };
    }

    cancel(): void {
        if (this.token.isCancellationRequested) return;
        (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
        for (const listener of [...this.listeners]) listener();
        this.listeners.clear();
    }

    dispose(): void { this.listeners.clear(); }
}

/** A source that is cancelled together with its parent token. */
export function linkedCancellation(parent: CancellationToken): CancellationSource & Disposable {
    const source = new CancellationSource();
    const listener = parent.onCancellationRequested(() => source.cancel());
    if (parent.isCancellationRequested) source.cancel();
    const dispose = source.dispose.bind(source);
    source.dispose = () => { listener.dispose(); dispose(); };
    return source;
}
