/**
 * Tool for resolving a relative GAP help link.
 */

import type { GapTool, PreparedInvocation } from './contracts';
import { ResolveLinkInput, ResolveLinkOutput, resolveLinkOutput } from './core/toolCore';

export class ResolveLinkTool implements GapTool<ResolveLinkInput, ResolveLinkOutput> {
    prepare(input: ResolveLinkInput): PreparedInvocation {
        return { invocationMessage: `Resolving GAP help link '${input.relativePath}'` };
    }

    execute(input: ResolveLinkInput): ResolveLinkOutput {
        return resolveLinkOutput(input);
    }
}
