import type { BindingAnalysis } from '../../language/analysis/bindings';
import { GAPReadCompletions as ReadCompletions } from '../../language/analysis/readCompletions';
import { languageHost } from '../languageHost';

export class GAPReadCompletions extends ReadCompletions {
    constructor(completionPath: string, analysis?: BindingAnalysis) { super(completionPath, languageHost, analysis); }
}
