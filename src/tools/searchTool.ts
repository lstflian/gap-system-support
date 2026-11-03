/**
 * Tool for searching the GAP help index.
 */

import * as fs from 'fs';
import type { GapTool, PreparedInvocation, ToolHost } from './contracts';
import { CONFIG_MISSING_MESSAGE, SearchInput, SearchOutput, ToolError, searchHelpTool } from './core/toolCore';
import { loadHelpIndex } from './helpIndex';

export class SearchHelpTool implements GapTool<SearchInput, SearchOutput> {
    constructor(private readonly host: ToolHost) {}

    prepare(input: SearchInput): PreparedInvocation {
        return { invocationMessage: `Searching the GAP help index for '${input.topic}'` };
    }

    execute(input: SearchInput): SearchOutput {
        const { docPath, pkgPath, searchMode } = this.host.helpSettings();
        if (!docPath || !fs.existsSync(docPath) || !pkgPath || !fs.existsSync(pkgPath)) {
            throw new ToolError(CONFIG_MISSING_MESSAGE);
        }
        const defaultMode = searchMode === 'substring' ? 'substring' : 'prefix';
        const state = loadHelpIndex(this.host);
        return searchHelpTool(input, state.entries, state.bookDescriptions, docPath, pkgPath, defaultMode);
    }
}
