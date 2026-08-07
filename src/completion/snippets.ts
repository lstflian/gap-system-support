/**
 * GAP statement structure snippets for completion.
 * The label is a readable description, the insertText is a snippet with tabstops.
 */

export interface StatementSnippet {
    /** Readable label shown in the completion list. */
    label: string;
    /** SnippetString body with tabstops. */
    insertText: string;
    /** Trigger keyword, e.g. 'if' for all if variants. */
    filterText: string;
    /** Order index among snippets with the same filterText. */
    index: number;
}

export const STATEMENT_SNIPPETS: StatementSnippet[] = [
    {
        label: 'if … then … fi',
        insertText: 'if ${1:condition} then\n    $0\nfi;',
        filterText: 'if',
        index: 1,
    },
    {
        label: 'if … then … else … fi',
        insertText: 'if ${1:condition} then\n    $2\nelse\n    $3\nfi;',
        filterText: 'if',
        index: 2,
    },
    {
        label: 'if … then … elif … else … fi',
        insertText: 'if ${1:condition} then\n    $3\nelif ${2:cond2} then\n    $4\nelse\n    $5\nfi;',
        filterText: 'if',
        index: 3,
    },
    {
        label: 'while … do … od',
        insertText: 'while ${1:condition} do\n    $0\nod;',
        filterText: 'while',
        index: 1,
    },
    {
        label: 'repeat … until',
        insertText: 'repeat\n    $0\nuntil ${1:condition};',
        filterText: 'repeat',
        index: 1,
    },
    {
        label: 'for … in … do … od',
        insertText: 'for ${1:var} in ${2:list} do\n    $0\nod;',
        filterText: 'for',
        index: 1,
    },
    {
        label: 'function … end',
        insertText: 'function(${1:args})\n    $0\nend;',
        filterText: 'function',
        index: 1,
    },
    {
        label: 'atomic function … end',
        insertText: 'atomic function(${1:args})\n    $0\nend;',
        filterText: 'atomic',
        index: 1,
    },
    {
        label: 'atomic … do … od',
        insertText: 'atomic ${1:expr} do\n    $0\nod;',
        filterText: 'atomic',
        index: 2,
    },
    {
        label: 'rec(…)',
        insertText: 'rec(${1:name} := ${0:value})',
        filterText: 'rec',
        index: 1,
    },
];
