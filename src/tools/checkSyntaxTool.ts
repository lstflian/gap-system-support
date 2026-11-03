/**
 * Tool for checking GAP source syntax.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CancellationToken } from 'vscode';
import { initGapParser } from '../language/parser/gapParser';
import { Failures, getErrorMessage } from '../shared/messages';
import type { GapTool, PreparedInvocation, ToolHost } from './contracts';
import { CheckSyntaxInput, CheckSyntaxOutput, ToolError, checkSyntaxDocument, checkSyntaxText, throwIfToolCancelled, toolTry } from './core/toolCore';

export class CheckSyntaxTool implements GapTool<CheckSyntaxInput, CheckSyntaxOutput> {
    constructor(private readonly host: ToolHost) {}

    prepare(input: CheckSyntaxInput): PreparedInvocation {
        return { invocationMessage: `Checking GAP syntax of '${input.filePath}'` };
    }

    async execute(input: CheckSyntaxInput, token: CancellationToken): Promise<CheckSyntaxOutput> {
        throwIfToolCancelled(token);
        if (typeof input.filePath !== 'string' || input.filePath.trim().length === 0) {
            throw new ToolError(Failures.filepathIsRequiredAndMustBeANonEmpty);
        }
        const filePath = input.filePath.trim();
        if (!path.isAbsolute(filePath)) {
            throw new ToolError(Failures.filepathMustBeAnAbsolutePath);
        }
        await initGapParser(this.host.location);
        throwIfToolCancelled(token);
        // Consume exact matches synchronously so the buffer cannot close before parsing.
        const lookup = this.host.openDocument(filePath);
        const open = lookup instanceof Promise ? await lookup : lookup;
        throwIfToolCancelled(token);
        if (open && !open.isClosed) {
            return checkSyntaxDocument(open);
        }
        const code = toolTry(
            () => fs.readFileSync(filePath, 'utf-8'),
            (err) => Failures.failedToRead(filePath, getErrorMessage(err)),
        );
        return checkSyntaxText(code);
    }
}
