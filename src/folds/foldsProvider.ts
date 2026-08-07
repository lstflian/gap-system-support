/**
 * GAP folding range provider.
 * Driven by queries/folds.scm.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { getDocumentTree, isParserReady, getGapLanguage } from '../parser/gapParser';
import { hasErrorAncestor } from '../semantic/locals';
import type { Query } from 'web-tree-sitter';

export class GAPFoldsProvider implements vscode.FoldingRangeProvider {

    private foldQuery: Query | null = null;
    private foldText: string;

    constructor(foldsPath: string) {
        this.foldText = fs.readFileSync(foldsPath, 'utf-8');
    }

    private getFoldQuery(): Query {
        if (!this.foldQuery) {
            this.foldQuery = getGapLanguage().query(this.foldText);
        }
        return this.foldQuery;
    }

    provideFoldingRanges(
        document: vscode.TextDocument,
    ): vscode.FoldingRange[] {
        if (!isParserReady()) return [];

        // The cached document tree, the manager owns its lifetime.
        const tree = getDocumentTree(document);
        const ranges: vscode.FoldingRange[] = [];

        // Each @fold capture node becomes one folding range.
        for (const match of this.getFoldQuery().matches(tree.rootNode)) {
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
