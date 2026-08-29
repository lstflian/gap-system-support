/**
 * Centralized capacity limits.
 * Adjust file size and cache limits here only.
 */

// Read chain (completion + hover) and scoped completions.

/** Over this length (UTF-16 code units) a loaded file is skipped. */
export const READ_CONTENT_LIMIT = 1 * 1024 * 1024;

/** Read chain file cache entries before the least recently used is evicted. */
export const READ_FILE_CACHE_MAX_ENTRIES = 64;

/** Over this length (UTF-16 code units) documents skip scoped completions. */
export const SCOPED_CONTENT_LIMIT = 1 * 1024 * 1024;

/** Scoped completion model cache entries before the oldest is evicted. */
export const SCOPED_MODEL_CACHE_MAX_ENTRIES = 32;

// Semantic tokens.

/** Over this length (UTF-16 code units) documents skip semantic tokens. */
export const SEMANTIC_CONTENT_LIMIT = 2 * 1024 * 1024;

/** Semantic global cache entries before the least recently used is evicted. */
export const SEMANTIC_GLOBAL_CACHE_MAX_ENTRIES = 32;

/** Semantic global cache byte budget, default when no option is given. */
export const SEMANTIC_GLOBAL_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/** Semantic text cache entries before the least recently used is evicted. */
export const SEMANTIC_TEXT_CACHE_MAX_ENTRIES = 8;

/** Semantic text cache byte budget. */
export const SEMANTIC_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

// Parser document cache.

/** Cached documents before the least recently used is dropped. */
export const PARSER_MAX_DOCS = 20;

/** Cached text total (UTF-16 code units) before states are dropped. */
export const PARSER_MAX_TOTAL_TEXT = 50 * 1024 * 1024;

/** Milliseconds before an untouched document state is dropped. */
export const PARSER_MAX_IDLE_MS = 3 * 60 * 1000;

/** Pending edits per document before the batch is dropped. */
export const PARSER_MAX_PENDING_EDITS = 1000;
