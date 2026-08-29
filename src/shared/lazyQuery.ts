/**
 * Lazy tree-sitter query: stores the query text, compiles on first use.
 */

import type { Query } from 'web-tree-sitter';
import { getGapLanguage } from '../parser/gapParser';

export class LazyQuery {

    private query: Query | null = null;
    private readonly queryText: string;

    constructor(queryText: string) {
        this.queryText = queryText;
    }

    /** Get the compiled query, compiling it on first use. */
    get(): Query {
        if (!this.query) {
            this.query = getGapLanguage().query(this.queryText);
        }
        return this.query;
    }

    dispose(): void {
        this.query?.delete();
        this.query = null;
    }
}
