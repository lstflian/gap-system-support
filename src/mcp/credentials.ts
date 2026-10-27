import { randomBytes, randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { Messages } from '../shared/messages';

const PROFILE_TOKEN_KEY = 'gap.mcp.tokenKey';
const TOKEN_KEY_PREFIX = 'gap.mcp.token.';

export function isMcpToken(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export class McpCredentials {
    private pending = Promise.resolve();

    constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'secrets'>) {}

    handlesChange(key: string): boolean {
        return key === this.context.globalState.get<unknown>(PROFILE_TOKEN_KEY);
    }

    private async storageKey(): Promise<string> {
        let key = this.context.globalState.get<unknown>(PROFILE_TOKEN_KEY);
        if (key === undefined) {
            key = TOKEN_KEY_PREFIX + randomUUID();
            await this.context.globalState.update(PROFILE_TOKEN_KEY, key);
            key = this.context.globalState.get<unknown>(PROFILE_TOKEN_KEY);
        }
        if (typeof key !== 'string' || !key.startsWith(TOKEN_KEY_PREFIX)) {
            throw new Error(Messages.mcp.invalidCredentialStorage);
        }
        return key;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation);
        // Keep the queue usable after a failure; the caller still receives the rejected result.
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    getToken(): Promise<string> {
        return this.enqueue(async () => {
            // SecretStorage is extension-wide; the non-secret profile marker keeps profiles separate.
            const key = await this.storageKey();
            let token = await this.context.secrets.get(key);
            if (token === undefined) {
                await this.context.secrets.store(key, randomBytes(32).toString('hex'));
                token = await this.context.secrets.get(key);
            }
            if (!isMcpToken(token)) throw new Error(Messages.mcp.invalidCredentialStorage);
            return token;
        });
    }

    resetToken(): Promise<void> {
        return this.enqueue(async () => {
            const key = await this.storageKey();
            await this.context.secrets.store(key, randomBytes(32).toString('hex'));
        });
    }
}
