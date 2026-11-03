import { ensureHelpIndex, getHelpState, invalidateHelpIndexIfChanged } from '../help/helpData';
import type { HelpEntry } from '../help/indexData';
import { Failures } from '../shared/messages';
import type { ToolHost } from './contracts';
import { ToolError, toolTry } from './core/toolCore';

/** Load the help index for a tool call, noticing a rebuild by another process. */
export function loadHelpIndex(host: ToolHost): { entries: HelpEntry[]; bookDescriptions: Map<string, string> } {
    toolTry(
        () => ensureHelpIndex(host.location),
        err => `The GAP help index could not be loaded: ${(err as Error).message}`,
    );
    if (host.sharedHelpIndex) invalidateHelpIndexIfChanged();
    const state = getHelpState();
    if (!state.entries.length) {
        throw new ToolError(Failures.theGapHelpIndexIsEmptyTryGapRebuild);
    }
    return state;
}
