/** Provide hover content for GAP function names. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { getFunctionNames } from '../completion/dataManager';
import { GAPDefinitionResolver, ResolvedDefinition } from './definitionResolver';
import { definitionPathLink } from './format';
import { getHelpState } from '../help/helpData';
import type { HelpEntry } from '../help/indexData';
import { simpleString } from '../help/simpleString';
import { functionNameNodeAt, symbolLookupName, symbolNameNodeAt } from '../shared/functionName';
import { resolveHelpPath } from '../path';
import { BUILTIN_FUNCTION_NAMES } from '../completion/builtinNames';
import { LruCache } from '../shared/lruCache';
import { HOVER_HELP_DESCRIPTION_CACHE_MAX_ENTRIES } from '../limits';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import * as fs from 'fs';

const FALLBACK_FORMS = [
    'name := function(...)',
    'name := atomic function(...)',
    'name := x -> ...',
    'name := {x, y, ...} -> ...',
];

const KEYWORD_DESCRIPTIONS: Readonly<Record<string, { type: string; description: string }>> = {
    if: { type: 'conditional keyword', description: 'Starts a conditional block.' },
    then: { type: 'conditional keyword', description: 'Starts the body of a conditional branch.' },
    elif: { type: 'conditional keyword', description: 'Adds another condition to a conditional block.' },
    else: { type: 'conditional keyword', description: 'Starts the fallback branch of a conditional block.' },
    fi: { type: 'conditional keyword', description: 'Ends a conditional block.' },
    not: { type: 'logical operator', description: 'Negates a boolean condition.' },
    and: { type: 'logical operator', description: 'Requires both boolean conditions to be true.' },
    or: { type: 'logical operator', description: 'Requires at least one boolean condition to be true.' },
    in: { type: 'operator keyword', description: 'Tests membership or introduces a loop collection.' },
    mod: { type: 'operator keyword', description: 'Computes the remainder after integer division.' },
    function: { type: 'function keyword', description: 'Starts a function expression.' },
    local: { type: 'function keyword', description: 'Declares names local to the current function.' },
    end: { type: 'function keyword', description: 'Ends a function expression.' },
    return: { type: 'control keyword', description: 'Returns a value from the current function.' },
    for: { type: 'loop keyword', description: 'Starts a loop over a collection.' },
    while: { type: 'loop keyword', description: 'Starts a loop controlled by a condition.' },
    do: { type: 'loop keyword', description: 'Starts the body of a loop.' },
    od: { type: 'loop keyword', description: 'Ends a for or while loop.' },
    repeat: { type: 'loop keyword', description: 'Starts a loop whose condition is checked at the end.' },
    until: { type: 'loop keyword', description: 'Ends a repeat loop when its condition becomes true.' },
    break: { type: 'control keyword', description: 'Stops the nearest enclosing loop.' },
    continue: { type: 'control keyword', description: 'Continues with the next iteration of the nearest loop.' },
    rec: { type: 'type keyword', description: 'Creates a record value.' },
    atomic: { type: 'modifier keyword', description: 'Marks an atomic function or statement.' },
    readonly: { type: 'modifier keyword', description: 'Marks an atomic function parameter as read-only.' },
    readwrite: { type: 'modifier keyword', description: 'Marks an atomic function parameter as readable and writable.' },
    quit: { type: 'control keyword', description: 'Exits the current session.' },
};

const LITERAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    true: 'The boolean true value.',
    false: 'The boolean false value.',
    fail: 'Represents failure when an operation cannot produce a normal result.',
};

const OPERATOR_DESCRIPTIONS: Readonly<Record<string, { type: string; description: string }>> = {
    ':=': { type: 'assignment operator', description: 'Assigns the value on the right to the name or component on the left.' },
    '->': { type: 'function operator', description: 'Creates a function from the parameter or parameter list on the left and the expression on the right.' },
    '=': { type: 'comparison operator', description: 'Tests whether two values are equal.' },
    '<>': { type: 'comparison operator', description: 'Tests whether two values are not equal.' },
    '<': { type: 'comparison operator', description: 'Tests whether the left value is less than the right value.' },
    '<=': { type: 'comparison operator', description: 'Tests whether the left value is less than or equal to the right value.' },
    '>': { type: 'comparison operator', description: 'Tests whether the left value is greater than the right value.' },
    '>=': { type: 'comparison operator', description: 'Tests whether the left value is greater than or equal to the right value.' },
    '+': { type: 'arithmetic operator', description: 'Adds two values, or applies unary positive when used with one operand.' },
    '-': { type: 'arithmetic operator', description: 'Subtracts the right value, or applies additive inverse when used with one operand.' },
    '*': { type: 'arithmetic operator', description: 'Multiplies two values.' },
    '/': { type: 'arithmetic operator', description: 'Computes the quotient of two values.' },
    '^': { type: 'power operator', description: 'Applies exponentiation, conjugation, or another supported power operation.' },
    '..': { type: 'range operator', description: 'Builds a range between values, optionally using a preceding step value.' },
    '...': { type: 'variadic marker', description: 'Marks the final function parameter as accepting the remaining arguments.' },
};

const PUNCTUATION_DESCRIPTIONS: Readonly<Record<string, { type: string; description: string }>> = {
    ';': { type: 'statement terminator', description: 'Ends the current statement.' },
};

function syntaxNodeAt(root: SyntaxNode, offset: number): SyntaxNode[] {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    return [
        root.descendantForIndex(clamped),
        root.descendantForIndex(Math.max(0, clamped - 1)),
    ].filter((node): node is SyntaxNode => node !== null);
}

function keywordNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    for (const node of syntaxNodeAt(root, offset)) {
        if (node && KEYWORD_DESCRIPTIONS[node.text]) return node;
    }
    return null;
}

function literalNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    for (const node of syntaxNodeAt(root, offset)) {
        if (node && LITERAL_DESCRIPTIONS[node.text]) return node;
    }
    return null;
}

function operatorNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    const node = root.descendantForIndex(clamped);
    return node && OPERATOR_DESCRIPTIONS[node.text] ? node : null;
}

function punctuationNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    const node = root.descendantForIndex(clamped);
    return node && PUNCTUATION_DESCRIPTIONS[node.text] ? node : null;
}

function selectorExpression(node: SyntaxNode): SyntaxNode {
    let current = node;
    while (current.parent &&
        (current.parent.type === 'record_selector' ||
            current.parent.type === 'component_selector') &&
        current.parent.namedChildren.some(child => child?.id === current.id)) {
        current = current.parent;
    }
    return current;
}

function hoverSymbolNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const symbol = symbolNameNodeAt(root, offset);
    if (symbol) return symbol;
    for (const node of syntaxNodeAt(root, offset)) {
        if ((node?.text === '.' || node?.text === '!.') &&
            (node.parent?.type === 'record_selector' ||
                node.parent?.type === 'component_selector')) {
            return node.parent.childForFieldName('selector');
        }
    }
    return null;
}

function hoverLookupName(node: SyntaxNode): string {
    const expression = selectorExpression(node);
    return expression.id === node.id ? symbolLookupName(node) : expression.text;
}

function isCallCallee(node: SyntaxNode): boolean {
    const expression = selectorExpression(node);
    const call = expression.parent;
    return call?.type === 'call' &&
        call.childForFieldName('function')?.id === expression.id;
}

function keywordMarkdown(keyword: string): vscode.MarkdownString {
    const info = KEYWORD_DESCRIPTIONS[keyword];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${info.type}**\n\n`);
    md.appendCodeblock(keyword, 'gap');
    md.appendMarkdown(`\n\n${info.description}`);
    return md;
}

function literalMarkdown(literal: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**built-in constant**\n\n');
    md.appendCodeblock(literal, 'gap');
    md.appendMarkdown(`\n\n${LITERAL_DESCRIPTIONS[literal]}`);
    return md;
}

function operatorMarkdown(operator: string): vscode.MarkdownString {
    const info = OPERATOR_DESCRIPTIONS[operator];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${info.type}**\n\n`);
    md.appendCodeblock(operator, 'gap');
    md.appendMarkdown(`\n\n${info.description}`);
    return md;
}

function punctuationMarkdown(punctuation: string): vscode.MarkdownString {
    const info = PUNCTUATION_DESCRIPTIONS[punctuation];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${info.type}**\n\n`);
    md.appendCodeblock(punctuation, 'gap');
    md.appendMarkdown(`\n\n${info.description}`);
    return md;
}

function fallbackMarkdown(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('No function information found. Please check the function name.\n\n');
    md.appendMarkdown('---\n\nUser defined functions support the following forms:\n\n');
    for (const form of FALLBACK_FORMS) {
        md.appendCodeblock(form, 'gap');
        md.appendMarkdown('\n');
    }
    return md;
}

/**
 * Render the hover for a GAP function.
 * Shows the function title and a link into GAP Help.
 */
interface BuiltinHelp {
    display: string;
    book: string;
    description?: string;
}

const helpDescriptionCache = new LruCache<string, { description?: string }>({
    maxEntries: HOVER_HELP_DESCRIPTION_CACHE_MAX_ENTRIES,
});
let indexedHelpEntries: HelpEntry[] | null = null;
let functionHelpIndex = new Map<string, HelpEntry[]>();

function decodeHtml(text: string): string {
    return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/** Read the first short prose paragraph after a GAPDoc function anchor. */
function readHelpDescription(filePath: string, anchor: string): string | undefined {
    if (!filePath || !anchor || !fs.existsSync(filePath)) return undefined;
    const cacheKey = `${filePath}#${anchor}`;
    const cached = helpDescriptionCache.peek(cacheKey);
    if (cached) {
        helpDescriptionCache.touch(cacheKey, cached);
        return cached.description;
    }

    let description: string | undefined;
    try {
        const html = fs.readFileSync(filePath, 'utf8');
        const anchorIndex = html.search(new RegExp(`id=["']${anchor}["']`));
        if (anchorIndex >= 0) {
            const afterAnchor = html.slice(anchorIndex);
            const paragraph = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i.exec(afterAnchor);
            if (paragraph) {
                const text = decodeHtml(paragraph[1]);
                if (text) description = text.length > 280 ? `${text.slice(0, 277).trimEnd()}...` : text;
            }
        }
    } catch {
        // A missing or unreadable documentation file should not disable Hover.
    }
    helpDescriptionCache.set(cacheKey, { description });
    return description;
}

function getFunctionHelpCandidates(name: string): HelpEntry[] {
    const entries = getHelpState().entries;
    if (entries !== indexedHelpEntries) {
        const nextIndex = new Map<string, HelpEntry[]>();
        for (const entry of entries) {
            if (entry.type !== 'F' && !entry.display) continue;
            const keys = new Set([entry.key, simpleString(entry.display)]);
            for (const key of keys) {
                if (!key) continue;
                const bucket = nextIndex.get(key);
                if (bucket) bucket.push(entry);
                else nextIndex.set(key, [entry]);
            }
        }
        indexedHelpEntries = entries;
        functionHelpIndex = nextIndex;
    }
    return functionHelpIndex.get(simpleString(name)) ?? [];
}

function findBuiltinHelp(name: string): BuiltinHelp | undefined {
    let exact: HelpEntry | undefined;
    let exactScore = -1;
    for (const entry of getFunctionHelpCandidates(name)) {
        if (entry.type !== 'F' && entry.display !== name) continue;
        const score =
            (entry.display === name ? 4 : 0) +
            (entry.book === 'Reference' ? 2 : 0) +
            (entry.filePath.startsWith('/doc/') ? 1 : 0);
        if (score > exactScore) {
            exact = entry;
            exactScore = score;
        }
    }
    if (!exact) return undefined;
    const config = vscode.workspace.getConfiguration('gap');
    const docPath = (config.get<string>('docPath') || '').trim();
    const pkgPath = (config.get<string>('pkgPath') || '').trim();
    return {
        display: exact.display,
        book: exact.book,
        description: readHelpDescription(resolveHelpPath(exact.filePath, docPath, pkgPath), exact.anchor),
    };
}

function systemMarkdown(name: string, help?: BuiltinHelp): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.searchHelpTerm'] };
    md.appendMarkdown('**built-in function**\n\n');
    md.appendCodeblock(help?.display || `${name}(...)`, 'gap');
    md.appendMarkdown('\n\n');
    if (help?.description) md.appendMarkdown(`${help.description}\n\n`);
    md.appendMarkdown(help
        ? `Defined in the ${help.book} help book. `
        : 'Provided by the language runtime. ');
    md.appendMarkdown('See more information in ');
    md.appendMarkdown(
        `[GAP Help](command:gap.searchHelpTerm?${encodeURIComponent(JSON.stringify([name]))})`
    );
    return md;
}

function userSymbolType(
    root: SyntaxNode,
    node: SyntaxNode,
    lookupName: string,
    resolved: ResolvedDefinition,
): string {
    if (resolved.symbolKind === 'parameter') return 'parameter';
    if (resolved.symbolKind === 'function' ||
        resolved.symbolKind === 'global-function' ||
        resolved.symbolKind === 'operation' ||
        resolved.symbolKind === 'method' ||
        resolved.symbolKind === 'attribute' ||
        functionNameNodeAt(root, node.startIndex)?.id === node.id ||
        /\b(?:atomic\s+)?function\b|->/.test(resolved.definitionLine)) {
        return 'function';
    }
    if (lookupName.includes('.') || lookupName.includes('!')) return 'record field';
    return 'variable';
}

function isIsBoundArgument(node: SyntaxNode): boolean {
    const expression = selectorExpression(node);
    const argumentList = expression.parent;
    const call = argumentList?.type === 'argument_list' ? argumentList.parent : null;
    const functionNode = call?.type === 'call' ? call.childForFieldName('function') : null;
    return functionNode?.type === 'identifier' &&
        functionNode.text === 'IsBound' &&
        argumentList?.namedChildren[0]?.id === expression.id;
}

/**
 * Render the hover for a user defined function.
 * Shows the title, a code block, and the comment lines.
 * Appends a Defined in link, or skips it for untitled documents.
 */
function customMarkdown(
    resolved: ResolvedDefinition & { symbolType?: string },
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.goToDefinition'] };
    md.appendMarkdown(`**${resolved.symbolType || 'symbol'}**\n\n`);
    md.appendCodeblock(resolved.definitionLine, 'gap');
    if (resolved.commentLines.length > 0) {
        // A separator between the code block and the comments.
        md.appendMarkdown('\n\n---\n\n');
        for (const line of resolved.commentLines) {
            // Comment lines render as Markdown (bold, code, links, math syntax), one comment line per displayed line.
            // The string is not trusted, so command links stay inert.
            md.appendMarkdown(line);
            md.appendMarkdown('  \n');
        }
    }
    if (resolved.filePath) {
        md.appendMarkdown('\n---\n\n');
        md.appendMarkdown(`Defined in ${definitionPathLink(resolved.filePath, resolved.row)}`);
    }
    return md;
}

export class GAPHoverProvider implements vscode.HoverProvider {

    private resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    onWorkspaceFilesChanged(): void {
        this.resolver.onWorkspaceFilesChanged();
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.Hover | undefined {
        if (!isParserReady()) return undefined;

        // Gate 1: only function name identifiers trigger a hover.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const operator = operatorNodeAt(tree.rootNode, offset);
        if (operator) {
            return new vscode.Hover(operatorMarkdown(operator.text), this.rangeOf(document, operator));
        }
        const punctuation = punctuationNodeAt(tree.rootNode, offset);
        if (punctuation) {
            return new vscode.Hover(
                punctuationMarkdown(punctuation.text),
                this.rangeOf(document, punctuation),
            );
        }
        const node = hoverSymbolNodeAt(tree.rootNode, offset);
        if (!node) {
            const keyword = keywordNodeAt(tree.rootNode, offset);
            if (keyword) {
                return new vscode.Hover(keywordMarkdown(keyword.text), this.rangeOf(document, keyword));
            }
            const literal = literalNodeAt(tree.rootNode, offset);
            if (literal) {
                return new vscode.Hover(literalMarkdown(literal.text), this.rangeOf(document, literal));
            }
            return undefined;
        }

        const name = hoverLookupName(node);

        // Gate 2: GAP functions win over user defined ones.
        const systemNames = getFunctionNames();
        const help = findBuiltinHelp(name);
        if (systemNames?.has(name) || BUILTIN_FUNCTION_NAMES.has(name) || help) {
            return new vscode.Hover(systemMarkdown(name, help), this.rangeOf(document, node));
        }

        // Gate 3: user-defined symbols resolved through the Read chain.
        let resolved = this.resolver.resolveDefinition(document, position, name);
        // A loader may use a symbol in an IsBound guard before Read() loads its definition.
        if (!resolved && isIsBoundArgument(node)) {
            resolved = this.resolver.resolveDefinitionFromFutureReads(document, position, name);
            if (!resolved) {
                resolved = this.resolver.resolveWorkspaceDefinition(document, name);
            }
        }
        if (!resolved && (name.includes('.') || name.includes('!')) && isCallCallee(node)) {
            resolved = this.resolver.resolveWorkspaceDefinition(document, name);
        }
        if (resolved) {
            return new vscode.Hover(
                customMarkdown({
                    ...resolved,
                    symbolType: userSymbolType(tree.rootNode, node, name, resolved),
                }),
                this.rangeOf(document, node),
            );
        }

        // Preserve the old fallback only for call-like function names.
        if (functionNameNodeAt(tree.rootNode, offset)?.id === node.id || isCallCallee(node)) {
            return new vscode.Hover(fallbackMarkdown(), this.rangeOf(document, node));
        }
        return undefined;
    }

    private rangeOf(document: vscode.TextDocument, node: SyntaxNode): vscode.Range {
        return new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column),
        );
    }
}
