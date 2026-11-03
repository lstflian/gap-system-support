import * as vscode from 'vscode';
import { isBashOnWindows, toShellPath } from '../path';
import { Messages } from '../shared/messages';
import { gapEnvironment, resolveGapInstallation } from './installation';

/** Raw `args` of the default Windows terminal profile; GAP runs inside WSL with them. */
export function defaultWindowsProfileArgs(): unknown {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const profile = config.get<string>('defaultProfile.windows');
    const profiles = config.get<Record<string, { args?: unknown } | null>>('profiles.windows');
    return profile ? profiles?.[profile]?.args : undefined;
}

export async function prepareGapTerminal(): Promise<{ command: string; env: Record<string, string>; key: string }> {
    if (isBashOnWindows()) return { command: 'gap', env: { NoDefaultCurrentDirectoryInExePath: '1' }, key: vscode.env.shell };
    const installation = await resolveGapInstallation(true);
    if (!installation) return { command: 'gap', env: { NoDefaultCurrentDirectoryInExePath: '1' }, key: vscode.env.shell };
    const executable = toShellPath(installation.executable);
    if (!executable) throw new Error(Messages.extension.unsafeShellPath(installation.executable));
    const inheritedEnvironment = { ...process.env };
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    type Environment = Record<string, string | null>;
    const profile = config.get<string>(`defaultProfile.${platform}`);
    const profiles = config.get<Record<string, { env?: Environment } | null>>(`profiles.${platform}`);
    for (const settings of [config.get<Environment>(`env.${platform}`), profile ? profiles?.[profile]?.env : undefined]) {
        const configuredPath = Object.entries(settings ?? {}).find(([key]) =>
            process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH');
        if (!configuredPath) continue;
        for (const key of Object.keys(inheritedEnvironment)) {
            if (process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH') delete inheritedEnvironment[key];
        }
        inheritedEnvironment[configuredPath[0]] = configuredPath[1] ?? undefined;
    }
    const inherited = gapEnvironment(installation, inheritedEnvironment);
    const pathKey = Object.keys(inherited).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    const env = { [pathKey]: inherited[pathKey] ?? '', NoDefaultCurrentDirectoryInExePath: '1' };
    // PowerShell parses a leading quoted string as an expression on every platform.
    const prefix = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(vscode.env.shell) ? '& ' : '';
    return { command: prefix + executable, env, key: JSON.stringify([vscode.env.shell, installation.executable, env]) };
}
