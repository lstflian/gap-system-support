## 0.3.3
1. Update `README.md` and `README.zh-cn.md`

## 0.3.2

1. Add language model tools for GAP help: `search_gap_help`, `list_gap_books`, and `gap_resolve_link` (referenced as `#gapSearch`, `#gapBooks`, and `#gapResolveLink` in chat)
2. `search_gap_help`: search the GAP help index and return entry locations (absolute path, target line, total lines), with book filtering and paging
3. `list_gap_books`: list all GAP help books by short name
4. `gap_resolve_link`: resolve a relative link inside a help file to the target file's absolute path, target line, and total lines

## 0.3.1

1. Add tree-sitter syntax diagnostics to GAP extension
2. Add `.gap` file association to GAP extension
3. Add hover on function names
4. Optimize the structure of files under `src/`

## 0.3.0

1. Integrate the [GAP Help extension](https://github.com/lstflian/gap-help), including search and documentation viewer.

## 0.2.2

1. Fix record members and call option names being recolored as variables
2. Map the `property` capture to `enumMember`

## 0.2.1

1. Incremental semantic highlighting for large files, with full fallback for safety
2. Semantic token type `enumMember` for record entries and selectors
3. Fix TextMate grammar for `'''` character literals

## 0.2.0

1. Scoped completion for variables, parameters and user defined functions visible at the cursor
2. Completion for user defined functions in other GAP files loaded via `Read`

## 0.1.0

1. Refine semantic highlighting

## 0.0.2

1. Split third-party notices out of `LICENSE` into `THIRDPARTYNOTICES.md`
2. Add author to `package.json`

## 0.0.1

1. Initial release
2. Semantic and syntax highlighting for GAP files (`.g`, `.gi`, `.gd`)
3. Code folds
4. Code completion for constants, keywords, statement snippets and GAP functions
5. Run GAP file in a terminal, with new or reuse terminal modes
6. Configure GAP command line options through a quick pick
7. Generate and reset completion data from a local GAP installation
8. Path conversion for WSL and Git Bash terminals
