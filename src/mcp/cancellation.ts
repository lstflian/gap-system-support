import type { CancellationToken, Disposable } from 'vscode';

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

export function throwIfCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested) {
        const error = new Error('Canceled');
        error.name = 'Canceled';
        throw error;
    }
}
