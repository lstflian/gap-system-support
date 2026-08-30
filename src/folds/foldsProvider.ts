/**
 * GAP folding range provider.
 * Driven by queries/folds.scm.
 */

import * as vscode from 'vscode';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor } from '../shared/treeUtils';
import { LazyQuery } from '../shared/lazyQuery';
import * as fs from 'fs';

export class GAPFoldsProvider implements vscode.FoldingRangeProvider {

    private readonly foldQuery: LazyQuery;

    constructor(foldsPath: string) {
        this.foldQuery = new LazyQuery(fs.readFileSync(foldsPath, 'utf-8'));
    }

    provideFoldingRanges(
        document: vscode.TextDocument,
    ): vscode.FoldingRange[] {
        if (!isParserReady()) return [];

        // The cached syntax tree; the parser manager owns its lifetime.
        const tree = getDocumentTree(document);
        const ranges: vscode.FoldingRange[] = [];

        // Each @fold capture node becomes one folding range.
        for (const match of this.foldQuery.get().matches(tree.rootNode)) {
            for (const capture of match.captures) {
                if (capture.name !== 'fold') continue;
                const node = capture.node;

                // Skip nodes inside ERROR subtrees.
                if (hasErrorAncestor(node)) continue;

                const start = node.startPosition.row;
                const end = node.endPosition.row;

                // Skip nodes on one line and empty nodes.
                if (end <= start) continue;

                // Fold from start to the line before end.
                ranges.push(new vscode.FoldingRange(start, end - 1));
            }
        }

        // Sort ranges.
        // Outer ranges come first when starts are equal.
        ranges.sort((a, b) =>
            a.start !== b.start
                ? a.start - b.start
                : (b.end ?? 0) - (a.end ?? 0)
        );

        return ranges;
    }
}
