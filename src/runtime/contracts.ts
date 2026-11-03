import type { GapInstallation } from './discovery';

/** What a GAP file run needs from its host: the VS Code window or the standalone MCP server. */
export interface RunEnvironment {
    /** The terminal shell; WSL and bash on Windows run GAP inside that shell. */
    readonly shell: string;
    /** gap.terminalRoot: the Unix root for Windows drive letters. */
    readonly terminalRoot: string;
    /** Raw `args` of the default Windows terminal profile, validated before a WSL launch. */
    wslProfileArgs(): unknown;
    /** The GAP installation to run; undefined falls back to `gap` on PATH. */
    resolveInstallation(): Promise<GapInstallation | undefined>;
}
