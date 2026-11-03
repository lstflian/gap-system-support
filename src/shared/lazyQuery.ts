/**
 * Lazy syntax query: stores the query text, compiles on first use.
 */

import { Query } from 'web-tree-sitter';
import { getGapLanguage } from '../language/parser/gapParser';

export class LazyQuery {

    private query: Query | null = null;
    private readonly queryText: string;

    constructor(queryText: string) {
        this.queryText = queryText;
    }

    get(): Query {
        if (!this.query) {
            this.query = new Query(getGapLanguage(), this.queryText);
        }
        return this.query;
    }

    dispose(): void {
        this.query?.delete();
        this.query = null;
    }
}
