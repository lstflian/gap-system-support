/**
 * Tool for listing the GAP help books.
 */

import type { GapTool, PreparedInvocation, ToolHost } from './contracts';
import { listBooksOutput } from './core/toolCore';
import { loadHelpIndex } from './helpIndex';

export class ListBooksTool implements GapTool<Record<string, never>, { books: string[] }> {
    constructor(private readonly host: ToolHost) {}

    prepare(): PreparedInvocation {
        return { invocationMessage: 'Listing the GAP help books' };
    }

    execute(): { books: string[] } {
        return listBooksOutput(loadHelpIndex(this.host).bookDescriptions);
    }
}
