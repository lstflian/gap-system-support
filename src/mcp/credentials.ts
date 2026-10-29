import { randomBytes, randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { getErrorMessage, Messages } from '../shared/messages';

const PROFILE_TOKEN_KEY = 'gap.mcp.tokenKey';
const TOKEN_KEY_PREFIX = 'gap.mcp.token.';

export function isMcpToken(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

interface CredentialState {
    key: string;
    revision: number;
}

export interface McpCredential extends CredentialState {
    token: string;
}

function isRevision(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function tokenRoot(key: string): string {
    return key.match(/^(.*)\.[0-9]+\.[0-9a-f-]{36}$/)?.[1] ?? key;
}

function newer(left: CredentialState, right: CredentialState): boolean {
    return left.revision > right.revision || (left.revision === right.revision && left.key > right.key);
}

function generation(key: string, root: string): CredentialState | undefined {
    const prefix = root + '.';
    if (!key.startsWith(prefix)) return undefined;
    const match = key.slice(prefix.length).match(/^([0-9]+)\.[0-9a-f-]{36}$/);
    const revision = match ? Number(match[1]) : undefined;
    return isRevision(revision) ? { key, revision } : undefined;
}

export class McpCredentials {
    private pending = Promise.resolve();

    constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>) {}

    handlesChange(key: string): boolean {
        // A secret notification can arrive before the corresponding Profile state.
        return key.startsWith(TOKEN_KEY_PREFIX);
    }

    isCurrent(key: string): boolean {
        try { return key === this.readState()?.key; }
        catch { return false; }
    }

    private readState(): CredentialState | undefined {
        const value = this.context.globalState.get<unknown>(PROFILE_TOKEN_KEY);
        if (value === undefined) return undefined;
        // Older versions stored the key and revision separately. Keep their saved secret.
        const key = typeof value === 'string' ? value : (value as Partial<CredentialState> | null)?.key;
        const revision = typeof value === 'string'
            ? this.context.globalState.get<unknown>('gap.mcp.credentialRevision', 0)
            : (value as Partial<CredentialState> | null)?.revision;
        if (typeof key !== 'string' || !key.startsWith(TOKEN_KEY_PREFIX)) {
            throw new Error(Messages.mcp.invalidCredentialStorage);
        }
        if (!isRevision(revision)) throw new Error(Messages.mcp.invalidCredentialStorage);
        return { key, revision };
    }

    private async storageState(): Promise<CredentialState> {
        let state = this.readState();
        if (!state) {
            await this.context.globalState.update(PROFILE_TOKEN_KEY, {
                key: TOKEN_KEY_PREFIX + randomUUID(), revision: 0,
            } satisfies CredentialState);
            state = this.readState();
        }
        if (!state) throw new Error(Messages.mcp.invalidCredentialStorage);
        return state;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation);
        // Keep the queue usable after a failure; the caller still receives the rejected result.
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private async successor(state: CredentialState): Promise<CredentialState | undefined> {
        const root = tokenRoot(state.key);
        let latest = state;
        for (const key of await this.context.secrets.keys()) {
            const candidate = generation(key, root);
            if (candidate && newer(candidate, latest)) latest = candidate;
        }
        return latest === state ? undefined : latest;
    }

    private async removeSuperseded(state: CredentialState): Promise<void> {
        let current = state;
        for (;;) {
            const replacement = await this.successor(current);
            if (replacement) {
                current = replacement;
                await this.context.globalState.update(PROFILE_TOKEN_KEY, current);
            }
            const root = tokenRoot(current.key);
            for (const key of await this.context.secrets.keys()) {
                const candidate = generation(key.endsWith('.pending') ? key.slice(0, -8) : key, root);
                if (key === root || (candidate && newer(current, candidate))) {
                    await this.context.secrets.delete(key);
                }
            }
            if (!await this.successor(current)) return;
        }
    }

    private async readToken(key: string): Promise<string | undefined> {
        const token = await this.context.secrets.get(key);
        if (token !== undefined) return token;
        const pending = await this.context.secrets.get(key + '.pending');
        // The reset may have committed the final value and removed staging between these reads.
        return pending ?? await this.context.secrets.get(key);
    }

    getCredential(): Promise<McpCredential> {
        return this.enqueue(async () => {
            // SecretStorage is extension-wide; the non-secret profile marker keeps profiles separate.
            for (;;) {
                const state = await this.storageState();
                const { key } = state;
                let token = await this.readToken(key);
                if (!this.isCurrent(key)) continue;
                if (token === undefined) {
                    // Secret changes can arrive before the Profile snapshot. Never recreate a retired key.
                    let replacement = await this.successor(state);
                    if (replacement) {
                        await this.context.globalState.update(PROFILE_TOKEN_KEY, replacement);
                        continue;
                    }
                    await this.context.secrets.store(key, randomBytes(32).toString('hex'));
                    // A reset may have published and deleted this key while creation was pending.
                    replacement = await this.successor(state);
                    if (replacement) {
                        await this.context.secrets.delete(key);
                        await this.context.globalState.update(PROFILE_TOKEN_KEY, replacement);
                        continue;
                    }
                    token = await this.readToken(key);
                    if (token === undefined) {
                        replacement = await this.successor(state);
                        if (replacement) {
                            await this.context.globalState.update(PROFILE_TOKEN_KEY, replacement);
                            continue;
                        }
                    }
                }
                if (!this.isCurrent(key)) continue;
                if (!isMcpToken(token)) throw new Error(Messages.mcp.invalidCredentialStorage);
                return { ...state, token };
            }
        });
    }

    getToken(): Promise<string> {
        return this.getCredential().then(credential => credential.token);
    }

    getInstanceId(): Promise<string> {
        return this.enqueue(async () => {
            let id = this.context.globalState.get<unknown>('gap.mcp.instanceId');
            if (id === undefined) {
                await this.context.globalState.update('gap.mcp.instanceId', randomUUID());
                id = this.context.globalState.get<unknown>('gap.mcp.instanceId');
            }
            if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(Messages.mcp.invalidCredentialStorage);
            return id;
        });
    }

    isInstance(id: string): boolean {
        return this.context.globalState.get('gap.mcp.instanceId') === id;
    }

    resetToken(): Promise<void> {
        return this.enqueue(async () => {
            // Switching the Profile marker also revokes credentials created by a concurrent first start.
            const value = this.context.globalState.get<unknown>(PROFILE_TOKEN_KEY);
            const previousKey = typeof value === 'string' ? value : (value as Partial<CredentialState> | null)?.key;
            const savedRevision = typeof value === 'object' && value !== null
                ? (value as Partial<CredentialState>).revision
                : this.context.globalState.get<unknown>('gap.mcp.credentialRevision', 0);
            const root = typeof previousKey === 'string' && previousKey.startsWith(TOKEN_KEY_PREFIX)
                ? tokenRoot(previousKey) : TOKEN_KEY_PREFIX + randomUUID();
            const previous = { key: typeof previousKey === 'string' && previousKey.startsWith(TOKEN_KEY_PREFIX) ? previousKey : root,
                revision: isRevision(savedRevision) ? savedRevision : 0 };
            const latest = await this.successor(previous) ?? previous;
            const revision = Math.max(Date.now(), latest.revision + 1);
            if (!isRevision(revision)) throw new Error(Messages.mcp.invalidCredentialStorage);
            // The namespace identifies this Profile's lineage without touching another Profile's secrets.
            const key = `${root}.${revision}.${randomUUID()}`;
            const pendingKey = key + '.pending';
            const token = randomBytes(32).toString('hex');
            // Unpublished candidates must not be discoverable as successors by another window.
            await this.context.secrets.store(pendingKey, token);
            // Publish both fields in one Profile update so another window cannot mix generations.
            try {
                await this.context.globalState.update(PROFILE_TOKEN_KEY, { key, revision } satisfies CredentialState);
            } catch (error) {
                try { await this.context.secrets.delete(pendingKey); }
                catch (cleanupError) { console.error('[GAP MCP] unused token cleanup failed:', cleanupError); }
                throw error;
            }
            try {
                await this.context.secrets.store(key, token);
                await this.context.secrets.delete(pendingKey);
                await this.removeSuperseded({ key, revision });
            }
            catch (error) { throw new Error(Messages.mcp.tokenCleanupFailed(getErrorMessage(error)), { cause: error }); }
        });
    }
}
