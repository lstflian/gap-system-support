import type { BindingAnalysis } from '../../language/analysis/bindings';
import { GAPDefinitionResolver as DefinitionResolver } from '../../language/analysis/definitionResolver';
import { languageHost } from '../languageHost';

export type { DefinitionSymbolKind, ResolvedDefinition } from '../../language/analysis/definitionResolver';
export class GAPDefinitionResolver extends DefinitionResolver {
    constructor(completionPath: string, analysis?: BindingAnalysis) { super(completionPath, languageHost, analysis); }
}
