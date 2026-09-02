/**
 * Shared guarded execution helpers.
 * All try/catch handling is centralized here so business code stays free of catch blocks.
 */

import * as fs from 'fs';

/**
 * Run fn; on error return the fallback.
 * The fallback may be a value or a factory built from the caught error.
 */
export function tryValue<T>(fn: () => T, fallback: T | ((err: unknown) => T)): T {
    try {
        return fn();
    } catch (err) {
        return typeof fallback === 'function'
            ? (fallback as (err: unknown) => T)(err)
            : fallback;
    }
}

/** Async variant of tryValue. */
export async function tryValueAsync<T>(
    fn: () => Promise<T>,
    fallback: T | ((err: unknown) => T | Promise<T>),
): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        return typeof fallback === 'function'
            ? await (fallback as (err: unknown) => T | Promise<T>)(err)
            : fallback;
    }
}

/** Run fn; on error run cleanup(err) and rethrow the original error. */
export function onError<T>(fn: () => T, cleanup: (err: unknown) => void): T {
    try {
        return fn();
    } catch (err) {
        cleanup(err);
        throw err;
    }
}

/** Async variant of onError. */
export async function onErrorAsync<T>(
    fn: () => Promise<T>,
    cleanup: (err: unknown) => void,
): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        cleanup(err);
        throw err;
    }
}

/** Run fn; on error log with console.error(label, err), nothing is thrown. */
export function tryLog<T>(fn: () => T, label: string): void {
    try {
        fn();
    } catch (err) {
        console.error(label, err);
    }
}

/** Ignore unlink errors, best effort cleanup. */
export function safeUnlink(filePath: string): void {
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Best effort cleanup, ignore.
    }
}

/** Ignore rename errors, best effort restore. */
export function safeRename(from: string, to: string): void {
    try {
        fs.renameSync(from, to);
    } catch {
        // Best effort restore, ignore.
    }
}

/** Read a file, warn on failure and return the fallback. */
export function tryReadFileWarn(filePath: string, name: string, fallback: string = ''): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e: any) {
        console.warn(`GAP: Failed to load ${name}: ${e.message}`);
        return fallback;
    }
}
