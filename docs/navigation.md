# Definition And Reference Navigation

The extension provides static definition and reference navigation through the
native VS Code APIs. It uses the existing Tree-sitter parser and does not start
or evaluate a GAP process.

## Editor Behavior

- **Go to Definition** (`F12`) resolves a symbol use to its definition,
  declaration, or available implementations.
- **Find All References** (`Shift+F12`) finds statically recognizable uses in
  the current workspace.
- `Command+click` on macOS or `Ctrl+click` on Windows/Linux follows a symbol
  use to its definition.
- Clicking a definition that has other references opens the native Peek view.
  The selected definition is omitted from the Peek results.
- Clicking a definition with no other references navigates to that definition
  without opening an empty Peek view.

When a declaration has multiple implementations, such as an operation with
several installed methods, all statically recognizable candidates are returned
and VS Code presents its normal location picker.

## Recognized Symbols

Navigation covers lexical variables, parameters, functions, record/component
paths, GAP declaration calls, installation calls, and binding calls. Complete
qualified paths are preserved, so names such as `A.Print` and `B.Print` do not
share reference results.

See [Definition Navigation Coverage](definition-navigation-coverage.md) for the
detailed construct list and static-analysis limits.

## Cross-File Resolution

Literal `Read("path")` chains are followed in source order, including nested
and circular chains. Open documents take precedence over their saved content.
For computed loaders such as `Read(Concatenation(...))`, a guarded workspace
fallback can resolve top-level symbols from `.g`, `.gd`, `.gi`, and `.gap`
files.

Workspace fallback is intentionally static. It does not execute package
initialization, evaluate computed names, or reproduce runtime method dispatch.

## Peek And Reference Rules

Reference collection uses the same symbol classifier as definition navigation:

- lexical scope and shadowing are preserved;
- declaration and implementation sites can be included or excluded according
  to the VS Code request;
- comments and ordinary strings are excluded;
- the selected occurrence is omitted from Peek results;
- qualified record and component paths are matched by their complete name.

## Performance

The definition resolver and Read-chain analysis live in the host-independent
[language analysis core](../src/language/analysis). Hover, definition and
reference providers share one resolver in the editor activation layer.

[Binding facts](../src/language/analysis/bindings.ts) distinguish parameters,
local declarations, assignments, and loop targets. Completion and the resolver
reuse these facts for an open document URI/version/tree, but retain their
individual lookup and shadowing policies. The recorded scope is syntactic
containment, not complete GAP variable-binding inference.

[Symbol facts](../src/language/analysis/symbols.ts) provide record members,
declaration/installation metadata, and source occurrence ranges. References
cache plain ranges rather than parser-owned nodes; workspace discovery and
target filtering remain in the editor provider.

Workspace file discovery and parsed symbol indexes are cached and invalidated
when relevant workspace files change. Repeated definition, reference, and Hover
requests reuse document trees, file events, and short-lived workspace lookup
caches instead of rescanning the workspace on every request.

Limits in `src/limits.ts` bound document size, cache sizes, and scanned content.
When a limit is reached, the provider returns no static result rather than
blocking the editor.

## Verification

The automated suite covers:

- same-file and cross-file definitions;
- `.gd` declarations and `.gi` implementations;
- multiple installed methods;
- lexical shadowing;
- nested `rec(...)` fields and dotted/component paths;
- Peek behavior with and without references;
- reference exclusion rules and workspace cache reuse;
- Hover resolution that shares the definition model.

Run the complete suite with:

```bash
npm test
```

For manual VS Code testing, build a VSIX with
`npx @vscode/vsce package` or launch an Extension Development Host with `F5`.
