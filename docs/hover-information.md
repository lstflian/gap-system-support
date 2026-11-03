# Hover Information

The extension provides lightweight static information when the pointer rests on
a GAP token. It does not execute GAP code and does not infer the runtime type
of a value.

## Symbol Categories

User-defined symbols are resolved using the same lexical and `Read()`-aware
model used by the navigation features. The Hover category can be:

- `function`
- `variable`
- `parameter`
- `record field`

The displayed definition line and directly preceding `##` comments are included
when a definition is available. Qualified record and component paths such as
`A.B` and `A!.B` are kept intact.

The category is a static symbol category, not a runtime GAP type. For example,
an assignment such as `value := Group(())` is shown as a `variable`; the
extension does not evaluate the expression to determine that the value is a
group.

## Built-in Functions

Built-in functions are recognized from three sources:

1. The generated completion data.
2. A small list of kernel-level names that GAP does not expose through the
   ordinary global-function enumeration.
3. The GAP help index.

Their Hover contains the function name, a short documentation paragraph when
the matching help file is available, the help book, and a command link to the
full GAP Help entry. The `gap.docPath` and `gap.pkgPath` settings are needed
to read the documentation paragraph; the basic built-in-function Hover still
works without them.

## Language Syntax

Common GAP keywords and operators have concise syntax descriptions. This
includes conditional keywords such as `if`, `then`, `elif`, `else`, and `fi`,
logical operators such as `not`, `and`, and `or`, and loop/function keywords
such as `for`, `while`, `repeat`, `function`, and `return`.

Symbolic operators are covered as well:

- assignment and function construction: `:=`, `->`;
- comparison: `=`, `<>`, `<`, `<=`, `>`, `>=`;
- arithmetic and power: `+`, `-`, `*`, `/`, `^`;
- ranges and variadic parameters: `..`, `...`.

The `;` statement terminator also has a short Hover description. All code shown
inside Hover, including definitions, built-in signatures, keywords, constants,
operators, punctuation, and fallback examples, is rendered as syntax-highlighted
GAP code. Hover code blocks use the GAP TextMate grammar because VS Code does
not apply document semantic tokens inside Markdown Hover content. The grammar
therefore includes fallback scopes for function calls, record fields,
parameters used by arrow functions, and ordinary variables. Operators use the
theme-visible `keyword.operator.expression` scope so default VS Code themes do
not render them with the same color as plain text.

These descriptions are intentionally short and are not a replacement for the
GAP language reference.

## Cross-file Loading

Normal definitions follow literal `Read("path")` chains and reuse the existing
read-file cache. A common GAP bootstrap pattern checks a name before loading
its implementation:

```gap
if not IsBound(MagneticEquivalence) then
  Read(Concatenation(directory, "magnetic/api.g"));
fi;
```

When hovering the argument of `IsBound(...)`, the extension can use a guarded
workspace lookup if the future `Read` path is dynamic. This allows the
`MagneticEquivalence` symbol to show its definition in another workspace file
without changing normal definition resolution rules for ordinary references.

The fallback is intentionally limited to the `IsBound(...)` guard. Arbitrary
dynamic loading, generated names, `EvalString`, and values supplied only by a
runtime-installed package cannot be resolved reliably without running GAP.

## Performance

Hover, definition and references use one shared definition resolver from
[the language analysis core](../src/language/analysis). The resolver reuses
[binding facts](../src/language/analysis/bindings.ts) with completion and consumes
[shared symbol metadata](../src/language/analysis/symbols.ts). Feature-specific
lookup and display rules remain unchanged. VS Code document/workspace access is supplied by the
editor adapter; the analysis core can also be hosted without VS Code.

Hover requests use:

- a lazily built index of help entries by normalized function name;
- an LRU cache for extracted documentation summaries;
- the existing parsed-document and read-file caches;
- a short-lived workspace symbol cache for cross-file lookups.

This keeps pointer movement from repeatedly scanning the complete help index or
reparsing the same source files.
