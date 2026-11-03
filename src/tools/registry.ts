import { Messages } from '../shared/messages';
import { CheckSyntaxTool } from './checkSyntaxTool';
import type { GapTool, ToolAnnotations, ToolEntry, ToolHost, ToolMetadata, ToolRegistry } from './contracts';
import { ListBooksTool } from './listBooksTool';
import { ResolveLinkTool } from './resolveLinkTool';
import { RunFileTool } from './runFileTool';
import { SearchHelpTool } from './searchTool';

export type { GapTool, ToolAnnotations, ToolEntry, ToolHost, ToolMetadata, ToolRegistry } from './contracts';

/** Tool identifiers; package.json contributes.languageModelTools defines their metadata. */
export const ToolNames = {
    searchHelp: 'gapSearchHelp',
    listBooks: 'gapListBooks',
    resolveLink: 'gapResolveLink',
    checkSyntax: 'gapCheckSyntax',
    runFile: 'gapRunFile',
} as const;

const READ_ONLY: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the tools from the extension manifest, the single source of their metadata.
 * Each tool uses one identifier for its name, reference name, display name and MCP name.
 */
export function createToolRegistry(manifest: unknown, host: ToolHost): ToolRegistry {
    if (!isRecord(manifest) || typeof manifest.version !== 'string'
        || !isRecord(manifest.contributes) || !Array.isArray(manifest.contributes.languageModelTools)) {
        throw new Error(Messages.tools.invalidManifest);
    }
    const metadata = new Map<string, ToolMetadata>();
    for (const value of manifest.contributes.languageModelTools) {
        if (!isRecord(value) || typeof value.name !== 'string' || value.displayName !== value.name
            || value.toolReferenceName !== value.name
            || typeof value.modelDescription !== 'string' || !isRecord(value.inputSchema)
            || value.inputSchema.type !== 'object' || metadata.has(value.name)) {
            throw new Error(Messages.tools.invalidManifest);
        }
        metadata.set(value.name, {
            name: value.name,
            displayName: value.name,
            modelDescription: value.modelDescription,
            inputSchema: { ...value.inputSchema, type: 'object' },
        });
    }
    function entry<I extends object, O extends object>(
        name: string,
        tool: GapTool<I, O>,
        annotations: ToolAnnotations = READ_ONLY,
    ): ToolEntry<I, O> {
        const definition = metadata.get(name);
        if (!definition) throw new Error(Messages.tools.invalidManifest);
        metadata.delete(name);
        return { metadata: definition, tool, annotations };
    }
    const search = entry(ToolNames.searchHelp, new SearchHelpTool(host));
    const books = entry(ToolNames.listBooks, new ListBooksTool(host));
    const resolve = entry(ToolNames.resolveLink, new ResolveLinkTool());
    const syntax = entry(ToolNames.checkSyntax, new CheckSyntaxTool(host));
    const runTool = new RunFileTool(host);
    const run = entry(ToolNames.runFile, runTool, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
    });
    if (metadata.size) throw new Error(Messages.tools.invalidManifest);
    return {
        version: manifest.version,
        forEach(visitor) {
            visitor(search);
            visitor(books);
            visitor(resolve);
            visitor(syntax);
            visitor(run);
        },
        dispose: () => runTool.dispose(),
        close: () => runTool.close(),
    };
}
