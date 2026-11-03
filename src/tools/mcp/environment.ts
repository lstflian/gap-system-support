/**
 * Settings passed from the VS Code window to the standalone stdio MCP server through its environment.
 * VS Code restarts the server when the provided definition, including this environment, changes.
 */

import * as os from 'os';
import * as path from 'path';
import type { RunEnvironment } from '../../runtime/contracts';
import { StandaloneGapInstallation } from '../../runtime/discovery';
import type { ToolHost } from '../contracts';

export const McpEnvironment = {
    storage: 'GAP_MCP_STORAGE',
    docPath: 'GAP_MCP_DOC_PATH',
    pkgPath: 'GAP_MCP_PKG_PATH',
    searchMode: 'GAP_MCP_SEARCH_MODE',
    shell: 'GAP_MCP_SHELL',
    terminalRoot: 'GAP_MCP_TERMINAL_ROOT',
    wslProfileArgs: 'GAP_MCP_WSL_ARGS',
    gapDirectory: 'GAP_MCP_GAP_DIRECTORY',
    workspaceRoots: 'GAP_MCP_WORKSPACE_ROOTS',
} as const;

export interface McpSettings {
    /** Writable folder for the copied help index: the extension's global storage. */
    storage: string;
    docPath: string;
    pkgPath: string;
    searchMode: string;
    shell: string;
    terminalRoot: string;
    wslProfileArgs?: unknown;
    /** The GAP installation folder chosen in VS Code, if any. */
    gapDirectory?: string;
    /** Workspace folders used as the default working directory of their files. */
    workspaceRoots: string[];
}

export function settingsToEnvironment(settings: McpSettings): Record<string, string> {
    const environment: Record<string, string> = {
        [McpEnvironment.storage]: settings.storage,
        [McpEnvironment.docPath]: settings.docPath,
        [McpEnvironment.pkgPath]: settings.pkgPath,
        [McpEnvironment.searchMode]: settings.searchMode,
        [McpEnvironment.shell]: settings.shell,
        [McpEnvironment.terminalRoot]: settings.terminalRoot,
        [McpEnvironment.workspaceRoots]: JSON.stringify(settings.workspaceRoots),
    };
    if (settings.wslProfileArgs !== undefined) environment[McpEnvironment.wslProfileArgs] = JSON.stringify(settings.wslProfileArgs);
    if (settings.gapDirectory) environment[McpEnvironment.gapDirectory] = settings.gapDirectory;
    return environment;
}

function parseJson(value: string | undefined): unknown {
    if (!value) return undefined;
    try { return JSON.parse(value); }
    catch { return value; }
}

function defaultShell(): string {
    return process.platform === 'win32'
        ? process.env.ComSpec || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
        : process.env.SHELL || '/bin/sh';
}

export function settingsFromEnvironment(environment: NodeJS.ProcessEnv): McpSettings {
    const roots = parseJson(environment[McpEnvironment.workspaceRoots]);
    return {
        storage: environment[McpEnvironment.storage] || path.join(os.tmpdir(), 'gap-system-support'),
        docPath: (environment[McpEnvironment.docPath] ?? '').trim(),
        pkgPath: (environment[McpEnvironment.pkgPath] ?? '').trim(),
        searchMode: environment[McpEnvironment.searchMode] || 'prefix',
        shell: environment[McpEnvironment.shell] || defaultShell(),
        terminalRoot: environment[McpEnvironment.terminalRoot] ?? '',
        wslProfileArgs: parseJson(environment[McpEnvironment.wslProfileArgs]),
        gapDirectory: environment[McpEnvironment.gapDirectory] || undefined,
        workspaceRoots: Array.isArray(roots)
            ? roots.filter((root): root is string => typeof root === 'string' && path.isAbsolute(root)) : [],
    };
}

function comparable(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The innermost workspace folder containing filePath, like VS Code's getWorkspaceFolder. */
export function containingRoot(filePath: string, roots: readonly string[]): string | undefined {
    const file = comparable(filePath);
    let best: string | undefined;
    let length = -1;
    for (const root of roots) {
        const key = comparable(root);
        const prefix = key.endsWith(path.sep) ? key : key + path.sep;
        if ((file === key || file.startsWith(prefix)) && key.length > length) {
            best = root;
            length = key.length;
        }
    }
    return best;
}

/** A host without editors: tools read files from disk and the caller has already trusted the server. */
export function createStandaloneToolHost(extensionRoot: string, settings: McpSettings): ToolHost {
    const installation = new StandaloneGapInstallation(extensionRoot, settings.gapDirectory);
    const environment: RunEnvironment = {
        shell: settings.shell,
        terminalRoot: settings.terminalRoot,
        wslProfileArgs: () => settings.wslProfileArgs,
        resolveInstallation: () => installation.resolve(),
    };
    return {
        location: {
            globalStorageUri: { fsPath: settings.storage },
            extensionUri: { fsPath: extensionRoot },
        },
        sharedHelpIndex: true,
        helpSettings: () => ({ docPath: settings.docPath, pkgPath: settings.pkgPath, searchMode: settings.searchMode }),
        openDocument: () => undefined,
        isTrusted: () => true,
        saveSource: async () => {},
        defaultCwd: filePath => containingRoot(filePath, settings.workspaceRoots) ?? os.homedir(),
        runEnvironment: () => environment,
    };
}
