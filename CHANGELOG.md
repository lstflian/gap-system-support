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
