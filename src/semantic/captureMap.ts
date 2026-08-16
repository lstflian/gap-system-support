/**
 * Capture name to VS Code token type mapping.
 * Punctuation and spell captures map to null, they have no standard type.
 */

import * as vscode from 'vscode';

const TOKEN_TYPES = [
    'keyword',
    'function',
    'parameter',
    'variable',
    'property',
    'comment',
    'string',
    'character',
    'number',
    'operator',
    'escapeSequence',
    'enumMember',
];

const TOKEN_MODIFIERS = [
    'declaration',
    'readonly',
    'defaultLibrary',
];

export const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export type TokenMapping = { type: string; modifiers: string[] };

export function isDefinitionLikeCapture(name: string): boolean {
    return name === 'variable.parameter' || name === 'variable.parameter.builtin' ||
        name === 'function' || name === 'function.builtin' ||
        name === 'variable' || name === 'constant' || name === 'constant.builtin' ||
        name === 'variable.builtin' || name === 'variable.member' || name === 'property';
}

export const CAPTURE_MAP: Record<string, TokenMapping | null> = {
    'character':                    { type: 'character', modifiers: [] },

    'comment':                      { type: 'comment',   modifiers: [] },

    'string.escape':                { type: 'escapeSequence', modifiers: [] },

    'number':                       { type: 'number',    modifiers: [] },
    'number.float':                 { type: 'number',    modifiers: [] },

    'keyword.operator':             { type: 'operator',   modifiers: [] },
    'operator':                     { type: 'operator',   modifiers: [] },

    'variable.parameter':           { type: 'parameter', modifiers: ['declaration'] },
    'variable.parameter.builtin':   { type: 'parameter', modifiers: ['defaultLibrary'] },

    'variable.member':              { type: 'enumMember',  modifiers: [] },
    'property':                     { type: 'enumMember',  modifiers: [] },

    'string':                       { type: 'string',    modifiers: [] },
    'string.special':               { type: 'string',    modifiers: [] },

    'function':                     { type: 'function',  modifiers: ['declaration'] },
    'function.call':                { type: 'function',  modifiers: [] },
    'function.builtin':             { type: 'function',  modifiers: ['defaultLibrary'] },

    'variable':                     { type: 'variable',  modifiers: [] },
    'constant':                     { type: 'variable',  modifiers: ['readonly'] },
    'constant.builtin':             { type: 'variable',  modifiers: ['readonly'] },
    'variable.builtin':             { type: 'variable',  modifiers: ['defaultLibrary'] },


    'keyword':                      { type: 'keyword',   modifiers: [] },
    'keyword.function':             { type: 'keyword',   modifiers: [] },
    'keyword.type':                 { type: 'keyword',   modifiers: [] },
    'keyword.modifier':             { type: 'keyword',   modifiers: [] },
    'keyword.repeat':               { type: 'keyword',   modifiers: [] },
    'keyword.conditional':          { type: 'keyword',   modifiers: [] },
    'keyword.return':               { type: 'keyword',   modifiers: [] },
    'keyword.directive':            { type: 'keyword',   modifiers: [] },

    'punctuation.delimiter':        null,
    'punctuation.bracket':          null,
    'punctuation.special':          null,
    'spell':                        null,
};
