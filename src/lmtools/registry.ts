import * as vscode from 'vscode';
import { SearchHelpTool } from './searchTool';
import { ListBooksTool } from './listBooksTool';
import { ResolveLinkTool } from './resolveLinkTool';
import { CheckSyntaxTool } from './checkSyntaxTool';
import { Messages } from '../shared/messages';

export interface ToolMetadata {
    name: string;
    displayName: string;
    modelDescription: string;
    inputSchema: { type: 'object'; [key: string]: unknown };
}

export interface ToolEntry<I extends object, O extends object> {
    metadata: ToolMetadata;
    tool: vscode.LanguageModelTool<I> & { execute(input: I, token: vscode.CancellationToken): O | Promise<O> };
}

export interface ToolRegistry {
    readonly version: string;
    forEach(visitor: <I extends object, O extends object>(entry: ToolEntry<I, O>) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createToolRegistry(context: vscode.ExtensionContext): ToolRegistry {
    const manifest: unknown = context.extension.packageJSON;
    if (!isRecord(manifest) || typeof manifest.version !== 'string'
        || !isRecord(manifest.contributes) || !Array.isArray(manifest.contributes.languageModelTools)) {
        throw new Error(Messages.tools.invalidManifest);
    }
    const metadata = new Map<string, ToolMetadata>();
    for (const value of manifest.contributes.languageModelTools) {
        if (!isRecord(value) || typeof value.name !== 'string' || typeof value.displayName !== 'string'
            || typeof value.modelDescription !== 'string' || !isRecord(value.inputSchema)
            || value.inputSchema.type !== 'object' || metadata.has(value.name)) {
            throw new Error(Messages.tools.invalidManifest);
        }
        metadata.set(value.name, {
            name: value.name,
            displayName: value.displayName,
            modelDescription: value.modelDescription,
            inputSchema: { ...value.inputSchema, type: 'object' },
        });
    }
    function entry<I extends object, O extends object>(
        name: string,
        tool: ToolEntry<I, O>['tool'],
    ): ToolEntry<I, O> {
        const definition = metadata.get(name);
        if (!definition) throw new Error(Messages.tools.invalidManifest);
        metadata.delete(name);
        return { metadata: definition, tool };
    }
    const search = entry('search_gap_help', new SearchHelpTool(context));
    const books = entry('list_gap_books', new ListBooksTool(context));
    const resolve = entry('gap_resolve_link', new ResolveLinkTool(context));
    const syntax = entry('check_gap_syntax', new CheckSyntaxTool(context));
    if (metadata.size) throw new Error(Messages.tools.invalidManifest);
    return {
        version: manifest.version,
        forEach(visitor) {
            visitor(search);
            visitor(books);
            visitor(resolve);
            visitor(syntax);
        },
    };
}
