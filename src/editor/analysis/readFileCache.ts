import { ReadChainFileCache as FileCache, resolveReadBaseDir as baseDir } from '../../language/analysis/readFileCache';
import type { SourceDocument } from '../../language/documents';
import { languageHost } from '../languageHost';

export { resolveReadTarget } from '../../language/analysis/readFileCache';
export class ReadChainFileCache<T> extends FileCache<T> {
    constructor(parse: (content: string) => T | null) { super(parse, languageHost); }
}
export function resolveReadBaseDir(document: SourceDocument): string | null { return baseDir(document, languageHost); }
