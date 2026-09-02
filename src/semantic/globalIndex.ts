/**
 * Incremental capture index for the semantic highlighting global data.
 * Keeps a lightweight topology and merges only dirty top levels after edits.
 */

import type { Edit, QueryMatch, SyntaxNode } from 'web-tree-sitter';
import type { DocumentTreeChange } from '../parser/gapParser';
import { CAPTURE_MAP, isDefinitionLikeCapture } from './captureMap';
import type { TokenMapping } from './captureMap';
import { byteKey, decodeByteKey } from '../shared/keys';
import { CAPTURE_KIND } from './locals';
import type { ScopeEntry } from './locals';
import { hasErrorAncestor } from '../shared/treeUtils';
import { tryValue } from '../shared/guarded';
import { Messages } from '../shared/messages';
import type { CollectGlobal } from './collect';

export interface OffsetRange {
    startIndex: number;
    endIndex: number;
}

export interface TopLevelRange extends OffsetRange {
    type: string;
}

export interface GlobalTopologyIndex {
    sourceLength: number;
    topLevels: TopLevelRange[];
}

export interface IndexedMapping extends OffsetRange {
    pattern: number;
    mapping: TokenMapping;
    captureName: string;
}

export interface IndexedDefinition extends OffsetRange {
    name: string;
    errorAncestor: boolean;
    scopeStart?: number;
    scopeEnd?: number;
}

export interface GlobalCaptureIndex extends GlobalTopologyIndex {
    mappings: IndexedMapping[];
    references: OffsetRange[];
    definitions: IndexedDefinition[];
    scopes: OffsetRange[];
}

interface IndexParts {
    mappings: IndexedMapping[];
    references: OffsetRange[];
    definitions: IndexedDefinition[];
    scopes: OffsetRange[];
}

export type GlobalIndexFallbackReason =
    'invalid-transition' |
    'too-many-edits' |
    'dirty-limit' |
    'query-limit' |
    'invalid-index';

type GlobalIndexUpdateResult = {
    status: 'updated';
    index: GlobalCaptureIndex;
    global: CollectGlobal;
    dirtyRatio: number;
    dirtyTopLevels: number;
    reusedGlobalIndex: boolean;
} | {
    status: 'fallback';
    reason: GlobalIndexFallbackReason;
    dirtyRatio: number;
};

export type GlobalTopologyUpdateResult = {
    status: 'updated';
    index: GlobalTopologyIndex;
    global: CollectGlobal;
    dirtyRatio: number;
    dirtyTopLevels: number;
    reusedGlobalIndex: boolean;
    materializedPreviousIndex: true;
} | {
    status: 'fallback';
    reason: GlobalIndexFallbackReason;
    dirtyRatio: number;
    materializedPreviousIndex: boolean;
};

const SCOPE_TYPES = new Set(['lambda', 'function', 'atomic_function']);
const MAX_INCREMENTAL_EDITS = 1;

function rangeKey(range: OffsetRange): string {
    return `${range.startIndex}:${range.endIndex}`;
}

function topLevelKey(range: TopLevelRange): string {
    return `${range.type}:${range.startIndex}:${range.endIndex}`;
}

function compareRange(left: OffsetRange, right: OffsetRange): number {
    return left.startIndex - right.startIndex || left.endIndex - right.endIndex;
}

function copyRange(range: OffsetRange): OffsetRange {
    return { startIndex: range.startIndex, endIndex: range.endIndex };
}

function getTopLevels(rootNode: SyntaxNode): TopLevelRange[] {
    return readGlobalTopology(rootNode).topLevels;
}

export function buildGlobalTopologyIndex(rootNode: SyntaxNode): GlobalTopologyIndex {
    return readGlobalTopology(rootNode);
}

function readGlobalTopology(rootNode: SyntaxNode): GlobalTopologyIndex {
    // Walk the named children with a cursor.
    // Wrapping every top level as a SyntaxNode is slow for large files.
    const topLevels: TopLevelRange[] = [];
    const cursor = rootNode.walk();
    try {
        if (cursor.gotoFirstChild()) {
            do {
                if (!cursor.nodeIsNamed) continue;
                topLevels.push({
                    type: cursor.nodeType,
                    startIndex: cursor.startIndex,
                    endIndex: cursor.endIndex,
                });
            } while (cursor.gotoNextSibling());
        }
    } finally {
        cursor.delete();
    }
    return { sourceLength: rootNode.endIndex, topLevels };
}

function nearestScope(node: SyntaxNode): SyntaxNode | null {
    let current: SyntaxNode | null = node;
    while (current && current.type !== 'source_file') {
        if (SCOPE_TYPES.has(current.type)) return current;
        current = current.parent;
    }
    return null;
}

function buildIndexParts(matches: QueryMatch[]): IndexParts {
    const mappingByRange = new Map<number, IndexedMapping>();
    const referenceByRange = new Map<number, OffsetRange>();
    const definitionRecords: IndexedDefinition[] = [];
    const scopeByRange = new Map<string, OffsetRange>();

    for (const match of matches) {
        for (const capture of match.captures) {
            const node = capture.node;
            const name = capture.name;
            const range = { startIndex: node.startIndex, endIndex: node.endIndex };

            if (name === 'local.scope') {
                if (!hasErrorAncestor(node)) scopeByRange.set(rangeKey(range), range);
                continue;
            }

            if (CAPTURE_KIND[name]) {
                // Record fields are not variables in GAP.
                if (CAPTURE_KIND[name] === 'field') continue;
                const scope = nearestScope(node);
                definitionRecords.push({
                    ...range,
                    name: node.text,
                    errorAncestor: hasErrorAncestor(node),
                    scopeStart: scope?.startIndex,
                    scopeEnd: scope?.endIndex,
                });
                continue;
            }

            if (name === 'local.reference') {
                referenceByRange.set(byteKey(range.startIndex, range.endIndex), range);
                continue;
            }

            const mapping = CAPTURE_MAP[name];
            if (!mapping || !isDefinitionLikeCapture(name)) continue;
            if ((name === 'variable.parameter' || name === 'variable.parameter.builtin') &&
                hasErrorAncestor(node)) {
                continue;
            }

            const key = byteKey(range.startIndex, range.endIndex);
            const existing = mappingByRange.get(key);
            if (!existing || match.pattern > existing.pattern) {
                mappingByRange.set(key, {
                    ...range,
                    pattern: match.pattern,
                    mapping,
                    captureName: name,
                });
            }
        }
    }

    return normalizeParts({
        mappings: [...mappingByRange.values()],
        references: [...referenceByRange.values()],
        definitions: definitionRecords,
        scopes: [...scopeByRange.values()],
    });
}

function normalizeParts(parts: IndexParts): IndexParts {
    // Deduplicate by range, mappings keep the highest pattern index.
    const mappingByRange = new Map<number, IndexedMapping>();
    for (const mapping of parts.mappings) {
        const key = byteKey(mapping.startIndex, mapping.endIndex);
        const existing = mappingByRange.get(key);
        if (!existing || mapping.pattern > existing.pattern) mappingByRange.set(key, mapping);
    }

    const referenceByRange = new Map<number, OffsetRange>();
    for (const reference of parts.references) {
        referenceByRange.set(byteKey(reference.startIndex, reference.endIndex), reference);
    }

    const scopeByRange = new Map<string, OffsetRange>();
    for (const scope of parts.scopes) scopeByRange.set(rangeKey(scope), scope);

    return {
        mappings: [...mappingByRange.values()].sort(compareRange),
        references: [...referenceByRange.values()].sort(compareRange),
        definitions: [...parts.definitions].sort((left, right) =>
            compareRange(left, right) || left.name.localeCompare(right.name)),
        scopes: [...scopeByRange.values()].sort(compareRange),
    };
}

function sortParts(parts: IndexParts): IndexParts {
    parts.mappings.sort(compareRange);
    parts.references.sort(compareRange);
    parts.definitions.sort((left, right) =>
        compareRange(left, right) || left.name.localeCompare(right.name));
    const scopeByRange = new Map<string, OffsetRange>();
    for (const scope of parts.scopes) scopeByRange.set(rangeKey(scope), scope);
    parts.scopes = [...scopeByRange.values()].sort(compareRange);
    return parts;
}

function buildGlobalCaptureIndexFromCollect(
    topology: GlobalTopologyIndex,
    code: string,
    global: CollectGlobal,
): GlobalCaptureIndex {
    // Rebuild the full capture index from the cached global data.
    // The code argument must be the old text, never the new text.
    const topologyError = validateGlobalTopologyIndex(topology, code.length);
    if (topologyError) throw new Error(topologyError);
    const mappings: IndexedMapping[] = [];
    for (const [key, finalInfo] of global.finalMappingIndex) {
        const range = decodeByteKey(key);
        mappings.push({
            startIndex: range.start,
            endIndex: range.end,
            pattern: 0,
            mapping: finalInfo.mapping,
            captureName: finalInfo.captureName,
        });
    }

    const references: OffsetRange[] = [];
    for (const key of global.referenceNodes) {
        const range = decodeByteKey(key);
        references.push({ startIndex: range.start, endIndex: range.end });
    }

    const definitions: IndexedDefinition[] = [];
    const representedDefinitions = new Set<number>();
    for (let scopeIndex = 0; scopeIndex < global.scopes.length; scopeIndex++) {
        const scope = global.scopes[scopeIndex];
        for (const [name, entries] of scope.definitions) {
            for (const entry of entries) {
                representedDefinitions.add(byteKey(entry.start, entry.end));
                definitions.push({
                    startIndex: entry.start,
                    endIndex: entry.end,
                    name,
                    errorAncestor: false,
                    scopeStart: scopeIndex === 0 ? undefined : scope.start,
                    scopeEnd: scopeIndex === 0 ? undefined : scope.end,
                });
            }
        }
    }
    for (const key of global.definitionNodes) {
        if (representedDefinitions.has(key)) continue;
        const range = decodeByteKey(key);
        definitions.push({
            startIndex: range.start,
            endIndex: range.end,
            // Definitions without a scope keep their name sliced from the text.
            name: code.slice(range.start, range.end),
            errorAncestor: false,
        });
    }

    const parts = sortParts({
        mappings,
        references,
        definitions,
        scopes: global.scopes.slice(1).map(scope => ({
            startIndex: scope.start,
            endIndex: scope.end,
        })),
    });
    return {
        sourceLength: topology.sourceLength,
        topLevels: topology.topLevels,
        ...parts,
    };
}

function scopeKey(start: number, end: number): string {
    return `${start}:${end}`;
}

export function buildCollectGlobalFromIndex(code: string, index: GlobalCaptureIndex): CollectGlobal {
    const finalMappingIndex = new Map<number, { mapping: TokenMapping; captureName: string }>();
    for (const entry of index.mappings) {
        finalMappingIndex.set(byteKey(entry.startIndex, entry.endIndex), {
            mapping: entry.mapping,
            captureName: entry.captureName,
        });
    }

    const referenceNodes = new Set<number>();
    for (const reference of index.references) {
        referenceNodes.add(byteKey(reference.startIndex, reference.endIndex));
    }

    const definitionNodes = new Set<number>();
    for (const definition of index.definitions) {
        definitionNodes.add(byteKey(definition.startIndex, definition.endIndex));
    }

    const scopes: ScopeEntry[] = [{
        start: 0,
        end: Number.MAX_SAFE_INTEGER,
        definitions: new Map(),
    }];
    const scopeEntries = index.scopes
        .map(scope => ({
            start: scope.startIndex,
            end: scope.endIndex,
            definitions: new Map(),
        } as ScopeEntry))
        // Sort outer scopes first, like the full build.
        .sort((left, right) =>
            (right.end - right.start) - (left.end - left.start) ||
            left.start - right.start || right.end - left.end);
    scopes.push(...scopeEntries);
    const scopeByRange = new Map(scopeEntries.map(scope => [scopeKey(scope.start, scope.end), scope]));

    for (const definition of index.definitions) {
        if (definition.errorAncestor) continue;
        const finalInfo = finalMappingIndex.get(byteKey(definition.startIndex, definition.endIndex));
        if (!finalInfo) continue;

        let target = scopes[0];
        if (definition.scopeStart !== undefined && definition.scopeEnd !== undefined) {
            const localScope = scopeByRange.get(scopeKey(definition.scopeStart, definition.scopeEnd));
            if (!localScope) throw new Error(Messages.semantic.definitionScopeMissing);
            target = localScope;
        }

        const definitions = target.definitions.get(definition.name) ?? [];
        definitions.push({
            start: definition.startIndex,
            end: definition.endIndex,
            mapping: finalInfo.mapping,
            captureName: finalInfo.captureName,
        });
        target.definitions.set(definition.name, definitions);
    }

    for (const scope of scopes) {
        for (const definitions of scope.definitions.values()) {
            // Sort by end ascending, the resolver walks from the back.
            definitions.sort((left, right) => left.end - right.end || left.start - right.start);
        }
    }

    const rawLines = code.split('\n');
    const lineLens = rawLines.map(line => line.endsWith('\r') ? line.length - 1 : line.length);
    return { finalMappingIndex, referenceNodes, definitionNodes, scopes, rawLines, lineLens };
}

function rangeIsValid(range: OffsetRange, sourceLength: number): boolean {
    return Number.isSafeInteger(range.startIndex) && Number.isSafeInteger(range.endIndex) &&
        range.startIndex >= 0 && range.startIndex <= range.endIndex && range.endIndex <= sourceLength;
}

export function validateGlobalTopologyIndex(
    index: GlobalTopologyIndex,
    sourceLength: number,
    rootNode?: SyntaxNode,
): string | null {
    if (index.sourceLength !== sourceLength) return 'source length does not match the index';

    const keys = new Set<string>();
    for (let position = 0; position < index.topLevels.length; position++) {
        const topLevel = index.topLevels[position];
        if (!rangeIsValid(topLevel, sourceLength)) return 'top-level range is outside the document';
        if (position > 0 && index.topLevels[position - 1].endIndex > topLevel.startIndex) {
            return 'top-level ranges overlap';
        }
        const key = topLevelKey(topLevel);
        if (keys.has(key)) return 'top-level range is duplicated';
        keys.add(key);
    }

    if (rootNode) {
        const actualTopLevels = getTopLevels(rootNode);
        if (actualTopLevels.length !== index.topLevels.length) return 'top-level count does not match the tree';
        for (let position = 0; position < actualTopLevels.length; position++) {
            if (topLevelKey(actualTopLevels[position]) !== topLevelKey(index.topLevels[position])) {
                return 'top-level range does not match the tree';
            }
        }
    }

    return null;
}

function findTopLevelIndex(topLevels: TopLevelRange[], range: OffsetRange): number {
    // Binary search for the top level that contains the range fully.
    let low = 0;
    let high = topLevels.length - 1;
    let candidate = -1;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        if (topLevels[middle].startIndex <= range.startIndex) {
            candidate = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    if (candidate < 0) return -1;
    const owner = topLevels[candidate];
    return range.endIndex <= owner.endIndex ? candidate : -1;
}

export function validateGlobalCaptureIndex(
    index: GlobalCaptureIndex,
    code: string,
    rootNode?: SyntaxNode,
): string | null {
    const topologyError = validateGlobalTopologyIndex(index, code.length, rootNode);
    if (topologyError) return topologyError;

    const rangeError = validateGlobalCaptureRanges(index, code.length);
    if (rangeError) return rangeError;

    const mappingKeys = new Set<number>();
    for (const mapping of index.mappings) {
        const key = byteKey(mapping.startIndex, mapping.endIndex);
        if (mappingKeys.has(key)) return 'mapping range is duplicated';
        mappingKeys.add(key);
    }

    const scopes = [...index.scopes].sort((left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex);
    const scopeKeys = new Set<string>();
    for (const scope of scopes) {
        const key = scopeKey(scope.startIndex, scope.endIndex);
        if (scopeKeys.has(key)) return 'scope range is duplicated';
        scopeKeys.add(key);
    }
    // Check scope nesting with a stack, crossing scopes are invalid.
    const stack: OffsetRange[] = [];
    for (const scope of scopes) {
        while (stack.length > 0 && scope.startIndex >= stack[stack.length - 1].endIndex) stack.pop();
        if (stack.length > 0 && scope.endIndex > stack[stack.length - 1].endIndex) {
            return 'scope ranges cross';
        }
        stack.push(scope);
    }

    for (const definition of index.definitions) {
        if (code.slice(definition.startIndex, definition.endIndex) !== definition.name) {
            return 'definition name does not match the document';
        }
        if (definition.errorAncestor) continue;
        if ((definition.scopeStart === undefined) !== (definition.scopeEnd === undefined)) {
            return 'definition scope is incomplete';
        }
        if (definition.scopeStart !== undefined && definition.scopeEnd !== undefined) {
            if (!scopeKeys.has(scopeKey(definition.scopeStart, definition.scopeEnd))) {
                return 'definition scope does not exist';
            }
            if (definition.startIndex < definition.scopeStart || definition.endIndex > definition.scopeEnd) {
                return 'definition lies outside its scope';
            }
        }
    }

    return null;
}

function validateGlobalCaptureRanges(
    index: GlobalCaptureIndex,
    sourceLength: number,
): string | null {
    const rangeGroups: OffsetRange[][] = [
        index.mappings,
        index.references,
        index.definitions,
        index.scopes,
    ];
    for (const ranges of rangeGroups) {
        let topLevelIndex = 0;
        for (let position = 0; position < ranges.length; position++) {
            const range = ranges[position];
            if (!rangeIsValid(range, sourceLength)) return 'capture range is outside the document';
            if (position > 0 && compareRange(ranges[position - 1], range) > 0) {
                return 'capture ranges are not sorted';
            }
            while (topLevelIndex < index.topLevels.length &&
                index.topLevels[topLevelIndex].endIndex <= range.startIndex) {
                topLevelIndex++;
            }
            const owner = index.topLevels[topLevelIndex];
            if (!owner || range.startIndex < owner.startIndex || range.endIndex > owner.endIndex) {
                return 'capture crosses a top-level boundary';
            }
        }
    }
    return null;
}

function mapBoundary(index: number, edit: Edit, bias: 'left' | 'right'): number {
    // Map one range boundary across an edit.
    // Boundaries inside the edit snap left to its start and right to its end.
    const delta = edit.newEndIndex - edit.oldEndIndex;
    if (index < edit.startIndex) return index;
    if (index > edit.oldEndIndex) return index + delta;
    if (edit.startIndex === edit.oldEndIndex) {
        return bias === 'right' ? edit.newEndIndex : edit.startIndex;
    }
    if (index === edit.startIndex) return bias === 'right' ? edit.newEndIndex : edit.startIndex;
    if (index === edit.oldEndIndex) return edit.newEndIndex;
    return bias === 'right' ? edit.newEndIndex : edit.startIndex;
}

function mapRange(range: OffsetRange, edits: readonly Edit[]): OffsetRange {
    // Start maps right, end maps left.
    let mapped = copyRange(range);
    for (const edit of edits) {
        mapped = {
            startIndex: mapBoundary(mapped.startIndex, edit, 'right'),
            endIndex: mapBoundary(mapped.endIndex, edit, 'left'),
        };
    }
    return mapped;
}

function rangeTouchesEdit(range: OffsetRange, edit: Edit): boolean {
    if (edit.startIndex === edit.oldEndIndex) {
        return edit.startIndex >= range.startIndex && edit.startIndex <= range.endIndex;
    }
    return edit.startIndex <= range.endIndex && edit.oldEndIndex >= range.startIndex;
}

function rangesTouch(left: OffsetRange, right: OffsetRange): boolean {
    if (left.startIndex === left.endIndex) {
        return left.startIndex >= right.startIndex && left.startIndex <= right.endIndex;
    }
    if (right.startIndex === right.endIndex) {
        return right.startIndex >= left.startIndex && right.startIndex <= left.endIndex;
    }
    return left.startIndex <= right.endIndex && right.startIndex <= left.endIndex;
}

function validateTransition(change: DocumentTreeChange): boolean {
    if (change.edits.length === 0) return false;
    let length = change.oldTextLength;
    for (const edit of change.edits) {
        if (!Number.isSafeInteger(edit.startIndex) || !Number.isSafeInteger(edit.oldEndIndex) ||
            !Number.isSafeInteger(edit.newEndIndex) || edit.startIndex < 0 ||
            edit.startIndex > edit.oldEndIndex || edit.oldEndIndex > length ||
            edit.newEndIndex < edit.startIndex) {
            return false;
        }
        length += edit.newEndIndex - edit.oldEndIndex;
    }
    return length === change.newTextLength;
}

function remapParts(
    previous: GlobalCaptureIndex,
    edits: readonly Edit[],
    dirtyOld: Set<number>,
): IndexParts | null {
    // Keep entries of clean top levels and shift their ranges by the edit delta.
    // Any entry without an owning top level aborts the update.
    const keep = <T extends OffsetRange>(entries: T[], remap: (entry: T) => T): T[] | null => {
        const result: T[] = [];
        for (const entry of entries) {
            const owner = findTopLevelIndex(previous.topLevels, entry);
            if (owner < 0) return null;
            if (dirtyOld.has(owner)) continue;
            result.push(remap(entry));
        }
        return result;
    };

    const mappings = keep(previous.mappings, entry => ({ ...entry, ...mapRange(entry, edits) }));
    const references = keep(previous.references, entry => mapRange(entry, edits));
    const scopes = keep(previous.scopes, entry => mapRange(entry, edits));
    const definitions = keep(previous.definitions, entry => {
        const range = mapRange(entry, edits);
        if (entry.scopeStart === undefined || entry.scopeEnd === undefined) return { ...entry, ...range };
        const mappedScope = mapRange({ startIndex: entry.scopeStart, endIndex: entry.scopeEnd }, edits);
        return {
            ...entry,
            ...range,
            scopeStart: mappedScope.startIndex,
            scopeEnd: mappedScope.endIndex,
        };
    });
    if (!mappings || !references || !definitions || !scopes) return null;
    return { mappings, references, definitions, scopes };
}

function partsBelongToTopLevel(parts: IndexParts, topLevel: TopLevelRange): boolean {
    const ranges: OffsetRange[] = [
        ...parts.mappings,
        ...parts.references,
        ...parts.definitions,
        ...parts.scopes,
    ];
    return ranges.every(range => rangeBelongsToTopLevel(range, topLevel));
}

function rangeBelongsToTopLevel(range: OffsetRange, topLevel: TopLevelRange): boolean {
    return range.startIndex >= topLevel.startIndex && range.endIndex <= topLevel.endIndex;
}

function topLevelNodeAt(rootNode: SyntaxNode, index: number): SyntaxNode | null {
    // Clamp the index into the tree, then climb to the top level ancestor.
    if (rootNode.endIndex === 0) return null;
    let current: SyntaxNode | null = rootNode.namedDescendantForIndex(
        Math.min(Math.max(0, index), rootNode.endIndex - 1),
    );
    while (current.parent && current.parent.type !== 'source_file') current = current.parent;
    return current.parent?.type === 'source_file' ? current : null;
}

function partsForTopLevel(index: GlobalCaptureIndex, topLevel: TopLevelRange): IndexParts {
    // Slice the sorted entries that start inside the top level.
    const select = <T extends OffsetRange>(entries: T[]): T[] => {
        let low = 0;
        let high = entries.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (entries[middle].startIndex < topLevel.startIndex) low = middle + 1;
            else high = middle;
        }
        const start = low;
        while (low < entries.length && entries[low].startIndex < topLevel.endIndex) low++;
        return entries.slice(start, low);
    };
    return {
        mappings: select(index.mappings),
        references: select(index.references),
        definitions: select(index.definitions),
        scopes: select(index.scopes),
    };
}

function tokenMappingsEqual(left: TokenMapping, right: TokenMapping): boolean {
    return left.type === right.type && left.modifiers.length === right.modifiers.length &&
        left.modifiers.every((modifier, index) => modifier === right.modifiers[index]);
}

function indexPartsEqual(left: IndexParts, right: IndexParts): boolean {
    if (left.mappings.length !== right.mappings.length ||
        left.references.length !== right.references.length ||
        left.definitions.length !== right.definitions.length ||
        left.scopes.length !== right.scopes.length) {
        return false;
    }
    for (let index = 0; index < left.mappings.length; index++) {
        const a = left.mappings[index];
        const b = right.mappings[index];
        if (a.startIndex !== b.startIndex || a.endIndex !== b.endIndex ||
            a.captureName !== b.captureName || !tokenMappingsEqual(a.mapping, b.mapping)) {
            return false;
        }
    }
    for (let index = 0; index < left.references.length; index++) {
        const a = left.references[index];
        const b = right.references[index];
        if (a.startIndex !== b.startIndex || a.endIndex !== b.endIndex) return false;
    }
    for (let index = 0; index < left.definitions.length; index++) {
        const a = left.definitions[index];
        const b = right.definitions[index];
        if (a.startIndex !== b.startIndex || a.endIndex !== b.endIndex || a.name !== b.name ||
            a.errorAncestor !== b.errorAncestor || a.scopeStart !== b.scopeStart ||
            a.scopeEnd !== b.scopeEnd) {
            return false;
        }
    }
    for (let index = 0; index < left.scopes.length; index++) {
        const a = left.scopes[index];
        const b = right.scopes[index];
        if (a.startIndex !== b.startIndex || a.endIndex !== b.endIndex) return false;
    }
    return true;
}

function updateTextLines(global: CollectGlobal, code: string): CollectGlobal {
    const rawLines = code.split('\n');
    const lineLens = rawLines.map(line => line.endsWith('\r') ? line.length - 1 : line.length);
    return { ...global, rawLines, lineLens };
}

function tryReuseUnchangedGlobalIndex(
    previous: GlobalCaptureIndex,
    previousGlobal: CollectGlobal | undefined,
    rootNode: SyntaxNode,
    code: string,
    change: DocumentTreeChange,
    queryTopLevel: (node: SyntaxNode) => QueryMatch[] | null,
    dirtyLimit: number,
): GlobalIndexUpdateResult | null {
    // Fast path: an edit with zero net length inside one top level.
    // Requery that top level and reuse the index when its parts are unchanged.
    if (!previousGlobal || change.edits.length !== 1) return null;
    const edit = change.edits[0];
    if (edit.newEndIndex - edit.oldEndIndex !== 0) return null;
    const oldTopLevelIndex = findTopLevelIndex(previous.topLevels, {
        startIndex: edit.startIndex,
        endIndex: edit.oldEndIndex,
    });
    if (oldTopLevelIndex < 0) return null;

    const oldTopLevel = previous.topLevels[oldTopLevelIndex];
    const dirtyRatio = (oldTopLevel.endIndex - oldTopLevel.startIndex) /
        Math.max(1, change.oldTextLength, change.newTextLength);
    if (dirtyRatio > dirtyLimit) {
        return { status: 'fallback', reason: 'dirty-limit', dirtyRatio };
    }

    const newTopLevelNode = topLevelNodeAt(rootNode, edit.startIndex);
    if (!newTopLevelNode) return null;
    const newTopLevel: TopLevelRange = {
        type: newTopLevelNode.type,
        startIndex: newTopLevelNode.startIndex,
        endIndex: newTopLevelNode.endIndex,
    };
    if (topLevelKey(oldTopLevel) !== topLevelKey(newTopLevel) ||
        change.changedRanges.some(range => !rangeBelongsToTopLevel(range, newTopLevel))) {
        return null;
    }

    const matches = queryTopLevel(newTopLevelNode);
    if (!matches) return { status: 'fallback', reason: 'query-limit', dirtyRatio };
    const nextParts = buildIndexParts(matches);
    if (!partsBelongToTopLevel(nextParts, newTopLevel)) {
        return { status: 'fallback', reason: 'invalid-index', dirtyRatio };
    }
    const previousParts = partsForTopLevel(previous, oldTopLevel);
    if (!indexPartsEqual(previousParts, nextParts)) return null;

    return {
        status: 'updated',
        index: previous,
        global: updateTextLines(previousGlobal, code),
        dirtyRatio,
        dirtyTopLevels: 1,
        reusedGlobalIndex: true,
    };
}

function updateGlobalCaptureIndex(
    previous: GlobalCaptureIndex,
    rootNode: SyntaxNode,
    code: string,
    change: DocumentTreeChange,
    queryTopLevel: (node: SyntaxNode) => QueryMatch[] | null,
    dirtyLimit = 0.25,
    previousGlobal?: CollectGlobal,
    nextTopology?: GlobalTopologyIndex,
): GlobalIndexUpdateResult {
    if (change.edits.length > MAX_INCREMENTAL_EDITS) {
        return { status: 'fallback', reason: 'too-many-edits', dirtyRatio: 1 };
    }
    if (!validateTransition(change) || previous.sourceLength !== change.oldTextLength ||
        code.length !== change.newTextLength) {
        return { status: 'fallback', reason: 'invalid-transition', dirtyRatio: 1 };
    }

    const reused = tryReuseUnchangedGlobalIndex(
        previous,
        previousGlobal,
        rootNode,
        code,
        change,
        queryTopLevel,
        dirtyLimit,
    );
    if (reused) return reused;

    const topology = nextTopology ?? readGlobalTopology(rootNode);
    const newTopLevels = topology.topLevels;
    if (topology.sourceLength !== code.length) {
        return { status: 'fallback', reason: 'invalid-index', dirtyRatio: 1 };
    }
    const newByKey = new Map<string, number>();
    for (let index = 0; index < newTopLevels.length; index++) {
        const key = topLevelKey(newTopLevels[index]);
        if (newByKey.has(key)) return { status: 'fallback', reason: 'invalid-index', dirtyRatio: 1 };
        newByKey.set(key, index);
    }

    const dirtyOld = new Set<number>();
    const dirtyNew = new Set<number>();
    const matchedNew = new Set<number>();
    const newToOld = new Map<number, number>();
    const mappedOldTopLevels: TopLevelRange[] = [];

    // Match old top levels to new ones by key after remapping.
    // Unmatched or doubly matched old levels become dirty.
    for (let oldIndex = 0; oldIndex < previous.topLevels.length; oldIndex++) {
        const original = previous.topLevels[oldIndex];
        let current: TopLevelRange = { ...original };
        for (const edit of change.edits) {
            if (rangeTouchesEdit(current, edit)) dirtyOld.add(oldIndex);
            current = { ...current, ...mapRange(current, [edit]) };
        }
        // A fully replaced top level maps to an inverted range.
        // Collapse it to zero length, the level is already dirty.
        if (current.startIndex > current.endIndex) {
            current = { ...current, startIndex: current.endIndex };
        }
        mappedOldTopLevels.push(current);

        const newIndex = newByKey.get(topLevelKey(current));
        if (newIndex === undefined || matchedNew.has(newIndex)) {
            dirtyOld.add(oldIndex);
            continue;
        }
        matchedNew.add(newIndex);
        newToOld.set(newIndex, oldIndex);
        if (dirtyOld.has(oldIndex)) dirtyNew.add(newIndex);
    }

    for (let newIndex = 0; newIndex < newTopLevels.length; newIndex++) {
        if (!matchedNew.has(newIndex)) dirtyNew.add(newIndex);
    }

    // Mark every top level touched by a parser changed range as dirty.
    // The old side loop also catches levels without a new counterpart.
    for (const changedRange of change.changedRanges) {
        for (let newIndex = 0; newIndex < newTopLevels.length; newIndex++) {
            if (!rangesTouch(newTopLevels[newIndex], changedRange)) continue;
            dirtyNew.add(newIndex);
            const oldIndex = newToOld.get(newIndex);
            if (oldIndex !== undefined) dirtyOld.add(oldIndex);
        }
        for (let oldIndex = 0; oldIndex < mappedOldTopLevels.length; oldIndex++) {
            if (rangesTouch(mappedOldTopLevels[oldIndex], changedRange)) dirtyOld.add(oldIndex);
        }
    }

    // Propagate dirtiness between matched old and new top levels.
    for (const [newIndex, oldIndex] of newToOld) {
        if (dirtyOld.has(oldIndex)) dirtyNew.add(newIndex);
        if (dirtyNew.has(newIndex)) dirtyOld.add(oldIndex);
    }

    // Sum dirty lengths on both sides and fall back past the limit.
    let dirtyOldLength = 0;
    for (const index of dirtyOld) {
        dirtyOldLength += previous.topLevels[index].endIndex - previous.topLevels[index].startIndex;
    }
    let dirtyNewLength = 0;
    for (const index of dirtyNew) {
        dirtyNewLength += newTopLevels[index].endIndex - newTopLevels[index].startIndex;
    }
    const dirtyRatio = Math.max(dirtyOldLength, dirtyNewLength) /
        Math.max(1, change.oldTextLength, change.newTextLength);
    if (dirtyRatio > dirtyLimit) {
        return { status: 'fallback', reason: 'dirty-limit', dirtyRatio };
    }

    const retained = remapParts(previous, change.edits, dirtyOld);
    if (!retained) return { status: 'fallback', reason: 'invalid-index', dirtyRatio };

    // Requery every dirty new top level and merge its parts.
    for (const newIndex of [...dirtyNew].sort((left, right) => left - right)) {
        const newTopLevelNode = rootNode.namedChild(newIndex);
        if (!newTopLevelNode) return { status: 'fallback', reason: 'invalid-index', dirtyRatio };
        const matches = queryTopLevel(newTopLevelNode);
        if (!matches) return { status: 'fallback', reason: 'query-limit', dirtyRatio };
        const parts = buildIndexParts(matches);
        if (!partsBelongToTopLevel(parts, newTopLevels[newIndex])) {
            return { status: 'fallback', reason: 'invalid-index', dirtyRatio };
        }
        retained.mappings.push(...parts.mappings);
        retained.references.push(...parts.references);
        retained.definitions.push(...parts.definitions);
        retained.scopes.push(...parts.scopes);
    }

    // Normalize duplicates and reject any index that fails validation.
    const normalized = normalizeParts(retained);
    const index: GlobalCaptureIndex = {
        sourceLength: code.length,
        topLevels: newTopLevels,
        ...normalized,
    };
    if (validateGlobalCaptureIndex(index, code)) {
        return { status: 'fallback', reason: 'invalid-index', dirtyRatio };
    }

    return tryValue<GlobalIndexUpdateResult>(() => {
        return {
            status: 'updated',
            index,
            global: buildCollectGlobalFromIndex(code, index),
            dirtyRatio,
            dirtyTopLevels: dirtyNew.size,
            reusedGlobalIndex: false,
        };
    }, () => {
        return { status: 'fallback', reason: 'invalid-index', dirtyRatio };
    });
}

export function collectGlobalsEqual(left: CollectGlobal, right: CollectGlobal): boolean {
    if (left.finalMappingIndex.size !== right.finalMappingIndex.size ||
        left.referenceNodes.size !== right.referenceNodes.size ||
        left.definitionNodes.size !== right.definitionNodes.size ||
        left.rawLines.length !== right.rawLines.length || left.lineLens.length !== right.lineLens.length) {
        return false;
    }

    for (const [key, value] of left.finalMappingIndex) {
        const other = right.finalMappingIndex.get(key);
        if (!other || value.captureName !== other.captureName || !tokenMappingsEqual(value.mapping, other.mapping)) {
            return false;
        }
    }
    for (const key of left.referenceNodes) if (!right.referenceNodes.has(key)) return false;
    for (const key of left.definitionNodes) if (!right.definitionNodes.has(key)) return false;
    for (let index = 0; index < left.rawLines.length; index++) {
        if (left.rawLines[index] !== right.rawLines[index]) return false;
    }
    for (let index = 0; index < left.lineLens.length; index++) {
        if (left.lineLens[index] !== right.lineLens[index]) return false;
    }

    if (left.scopes.length !== right.scopes.length) return false;
    for (let scopeIndex = 0; scopeIndex < left.scopes.length; scopeIndex++) {
        const leftScope = left.scopes[scopeIndex];
        const rightScope = right.scopes[scopeIndex];
        if (leftScope.start !== rightScope.start || leftScope.end !== rightScope.end ||
            leftScope.definitions.size !== rightScope.definitions.size) {
            return false;
        }
        for (const [name, leftDefinitions] of leftScope.definitions) {
            const rightDefinitions = rightScope.definitions.get(name);
            if (!rightDefinitions || leftDefinitions.length !== rightDefinitions.length) return false;
            for (let definitionIndex = 0; definitionIndex < leftDefinitions.length; definitionIndex++) {
                const leftDefinition = leftDefinitions[definitionIndex];
                const rightDefinition = rightDefinitions[definitionIndex];
                if (leftDefinition.start !== rightDefinition.start || leftDefinition.end !== rightDefinition.end ||
                    leftDefinition.captureName !== rightDefinition.captureName ||
                    !tokenMappingsEqual(leftDefinition.mapping, rightDefinition.mapping)) {
                    return false;
                }
            }
        }
    }
    return true;
}

function definitelyTouchedTopLevelLength(
    topLevels: TopLevelRange[],
    startIndex: number,
    endIndex: number,
): number {
    if (startIndex === endIndex) {
        // A zero length insertion only counts when it is strictly inside a top level.
        const ownerIndex = findTopLevelIndex(topLevels, { startIndex, endIndex });
        if (ownerIndex < 0) return 0;
        const owner = topLevels[ownerIndex];
        return startIndex > owner.startIndex && startIndex < owner.endIndex
            ? owner.endIndex - owner.startIndex
            : 0;
    }

    let low = 0;
    let high = topLevels.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (topLevels[middle].endIndex <= startIndex) low = middle + 1;
        else high = middle;
    }

    let total = 0;
    while (low < topLevels.length && topLevels[low].startIndex < endIndex) {
        const topLevel = topLevels[low];
        total += topLevel.endIndex - topLevel.startIndex;
        low++;
    }
    return total;
}

function getDefiniteDirtyRatio(
    previous: GlobalTopologyIndex,
    next: GlobalTopologyIndex,
    change: DocumentTreeChange,
): number {
    // Sum the lengths of top levels the edit definitely touches on both sides.
    if (change.edits.length !== 1) return 0;
    const edit = change.edits[0];
    const oldLength = definitelyTouchedTopLevelLength(
        previous.topLevels,
        edit.startIndex,
        edit.oldEndIndex,
    );
    const newLength = definitelyTouchedTopLevelLength(
        next.topLevels,
        edit.startIndex,
        edit.newEndIndex,
    );
    return Math.max(oldLength, newLength) /
        Math.max(1, change.oldTextLength, change.newTextLength);
}

export function updateGlobalTopologyIndex(
    previous: GlobalTopologyIndex,
    previousGlobal: CollectGlobal,
    rootNode: SyntaxNode,
    code: string,
    change: DocumentTreeChange,
    queryTopLevel: (node: SyntaxNode) => QueryMatch[] | null,
    dirtyLimit = 0.25,
    fullMaterializedValidation = true,
): GlobalTopologyUpdateResult {
    if (change.edits.length > MAX_INCREMENTAL_EDITS) {
        return {
            status: 'fallback',
            reason: 'too-many-edits',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }
    // The incremental path assumes trees without ERROR nodes on both sides.
    if (change.oldHasError || change.newHasError) {
        return {
            status: 'fallback',
            reason: 'invalid-transition',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }
    if (!validateTransition(change) || previous.sourceLength !== change.oldTextLength ||
        code.length !== change.newTextLength) {
        return {
            status: 'fallback',
            reason: 'invalid-transition',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }
    const topologyError = validateGlobalTopologyIndex(previous, change.oldTextLength);
    if (topologyError) {
        return {
            status: 'fallback',
            reason: 'invalid-index',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }

    const nextTopology = readGlobalTopology(rootNode);
    const nextTopologyError = validateGlobalTopologyIndex(nextTopology, code.length);
    if (nextTopologyError) {
        return {
            status: 'fallback',
            reason: 'invalid-index',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }
    const definiteDirtyRatio = getDefiniteDirtyRatio(previous, nextTopology, change);
    if (definiteDirtyRatio > dirtyLimit) {
        return {
            status: 'fallback',
            reason: 'dirty-limit',
            dirtyRatio: definiteDirtyRatio,
            materializedPreviousIndex: false,
        };
    }

    // Rebuild the old text from the cached lines, never from the new text.
    // The previous index must be materialized in the old coordinates.
    const previousCode = previousGlobal.rawLines.join('\n');
    if (previousCode.length !== previous.sourceLength || previousCode.length !== change.oldTextLength) {
        return {
            status: 'fallback',
            reason: 'invalid-index',
            dirtyRatio: 1,
            materializedPreviousIndex: false,
        };
    }

    // Materialize the full capture index from the cached global data.
    const previousCaptureIndex = tryValue(
        () => buildGlobalCaptureIndexFromCollect(previous, previousCode, previousGlobal),
        null,
    );
    if (previousCaptureIndex === null) {
        return {
            status: 'fallback',
            reason: 'invalid-index',
            dirtyRatio: 1,
            materializedPreviousIndex: true,
        };
    }
    // Shadow mode validates the full index, enabled mode only the ranges.
    const materializedError = fullMaterializedValidation
        ? validateGlobalCaptureIndex(previousCaptureIndex, previousCode)
        : validateGlobalCaptureRanges(previousCaptureIndex, previousCode.length);
    if (materializedError) {
        return {
            status: 'fallback',
            reason: 'invalid-index',
            dirtyRatio: 1,
            materializedPreviousIndex: true,
        };
    }

    const result = updateGlobalCaptureIndex(
        previousCaptureIndex,
        rootNode,
        code,
        change,
        queryTopLevel,
        dirtyLimit,
        previousGlobal,
        nextTopology,
    );
    if (result.status === 'fallback') {
        return { ...result, materializedPreviousIndex: true };
    }
    return {
        ...result,
        // Keep only the lightweight topology in the provider cache.
        index: {
            sourceLength: result.index.sourceLength,
            topLevels: result.index.topLevels,
        },
        materializedPreviousIndex: true,
    };
}

export function estimateGlobalTopologyIndexBytes(index: GlobalTopologyIndex): number {
    let bytes = 160;
    for (const topLevel of index.topLevels) bytes += 56 + topLevel.type.length * 2;
    return bytes;
}
