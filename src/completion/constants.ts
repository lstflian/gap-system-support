/**
 * GAP builtin constants for completion.
 */

const BOOL_CONSTANTS: string[] = ['true', 'false', 'fail'];

const SPECIAL_CONSTANTS: string[] = ['infinity', 'last', 'last2', 'last3'];

export const GAP_CONSTANTS: string[] = [...BOOL_CONSTANTS, ...SPECIAL_CONSTANTS];
