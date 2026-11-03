import { getErrorMessage } from './messages';

export class GapError extends Error {
    constructor(readonly code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'GapError';
    }
}

export function errorCode(error: unknown): string | undefined {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
}

type Reporter = (message: string) => void;
let reporter: Reporter | undefined;

export function setErrorReporter(value: Reporter | undefined): void {
    reporter = value;
}

export function reportError(error: unknown, scope = 'GAP'): void {
    if (errorCode(error) === 'CANCELED'
        || (error instanceof Error && ['Canceled', 'CancellationError'].includes(error.name))) return;
    const cause = error instanceof Error && error.cause ? `: ${getErrorMessage(error.cause)}` : '';
    const code = errorCode(error);
    const message = `[${scope}]${code ? ` ${code}:` : ''} ${getErrorMessage(error)}${cause}`.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    if (reporter) reporter(message);
    else console.error(message);
}
