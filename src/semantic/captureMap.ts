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
    'number',
    'operator',
    'escapeSequence',
];

const TOKEN_MODIFIERS = [
    'declaration',
    'readonly',
    'defaultLibrary',
];

export const legend = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export type TokenMapping = { type: string; modifiers: string[] };

export const CAPTURE_MAP: Record<string, TokenMapping | null> = {
    'variable':                     { type: 'variable',  modifiers: [] },
    'constant':                     { type: 'variable',  modifiers: ['readonly'] },
    'function':                     { type: 'function',  modifiers: ['declaration'] },
    'function.call':                { type: 'function',  modifiers: [] },
    'function.builtin':             { type: 'function',  modifiers: ['defaultLibrary'] },
    'variable.parameter':           { type: 'parameter', modifiers: ['declaration'] },
    'variable.parameter.builtin':   { type: 'parameter', modifiers: ['defaultLibrary'] },
    'variable.member':              { type: 'property',  modifiers: [] },
    'property':                     { type: 'property',  modifiers: [] },
    'constant.builtin':             { type: 'variable',  modifiers: ['readonly'] },
    'variable.builtin':             { type: 'variable',  modifiers: ['defaultLibrary'] },

    'number':                       { type: 'number',    modifiers: [] },
    'number.float':                 { type: 'number',    modifiers: [] },
    'string':                       { type: 'string',    modifiers: [] },
    'character':                    { type: 'string',    modifiers: [] },
    'string.escape':                { type: 'escapeSequence', modifiers: [] },
    'string.special':               { type: 'string',    modifiers: [] },

    'keyword':                      { type: 'keyword',   modifiers: [] },
    'keyword.function':             { type: 'keyword',   modifiers: [] },
    'keyword.operator':             { type: 'keyword',   modifiers: [] },
    'keyword.type':                 { type: 'keyword',   modifiers: [] },
    'keyword.modifier':             { type: 'keyword',   modifiers: [] },
    'keyword.repeat':               { type: 'keyword',   modifiers: [] },
    'keyword.conditional':          { type: 'keyword',   modifiers: [] },
    'keyword.return':               { type: 'keyword',   modifiers: [] },
    'keyword.directive':            { type: 'keyword',   modifiers: [] },

    'operator':                     { type: 'operator',  modifiers: [] },
    'comment':                      { type: 'comment',   modifiers: [] },

    'punctuation.delimiter':        null,
    'punctuation.bracket':          null,
    'punctuation.special':          null,

    'spell':                        null,
};
