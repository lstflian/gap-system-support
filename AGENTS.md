# AGENTS.md

GAP System Support is a TypeScript VS Code extension for GAP editing, execution, documentation, and native/MCP tools.

## Development and verification

- Use npm and the committed lockfile. CI uses Node.js 22 on Windows, Linux, and macOS.
- Install dependencies with `npm ci` when needed. Use `npm run compile` before running individual test scripts.
- Run `npm test` for code changes; it already compiles the extension. Add or update focused regression tests when behavior changes.
- The real GAP smoke test requires `GAP_TEST_INSTALLATION` and otherwise skips; CI does not configure it. VS Code host integration tests run separately with an isolated user-data directory and empty workspace because they modify settings.
- For documentation-only changes, validate local links and run `git diff --check`. Check new, untracked files too; a build is unnecessary.

## Code boundaries

- [src/language/](src/language/) must load without the VS Code runtime. Shared [analysis](src/language/analysis/) must not depend on editor or semantic-highlighting code.
- [src/runtime/](src/runtime/) must not depend on editor or tool modules. Preserve platform-specific quoting, file-identity checks, and cancellation of process trees.
- Reuse the shared parser and symbol analysis. Preserve UTF-16 offsets, open-buffer precedence, cache invalidation, and tree ownership: callers must not delete shared document trees; temporary trees need cleanup.
- [package.json](package.json) is the source of tool names, descriptions, and schemas. Native and MCP adapters share business logic; native syntax checks use open buffers, while standalone MCP checks saved files.
- Keep startup lazy. MCP uses stdio: stdout carries the protocol and diagnostics go to stderr. Static syntax validity and normal process completion do not guarantee a successful GAP program.

## Error handling

- Define extension error and warning text in [messages.ts](src/shared/messages.ts), using `Messages`/`Failures` and parameterized message factories. Do not hardcode error text in feature files or create per-feature message catalogs.
- Use [errors.ts](src/shared/errors.ts) for error reporting and [notify.ts](src/shared/notify.ts) for VS Code error/warning notifications. Keep the notification layer out of host-independent code.
- Reuse [guarded.ts](src/shared/guarded.ts) for common fallback and cleanup. Local catches may handle necessary recovery, cancellation, or tool-protocol translation; preserve cancellation and expected missing-file behavior, and avoid silent unexpected failures or duplicate reporting.

## Generated files

- Edit [highlights.source.scm](queries/highlights.source.scm), then run `npm run generate:highlight-queries`. Verify with `npm run generate:highlight-queries -- --check`; do not hand-edit the two generated highlight queries.
- Generate completion data with [collect-all-functions.g](scripts/gapFunctions/collect-all-functions.g) and the JSON conversion in [dataManager.ts](src/editor/completion/dataManager.ts); generate help indexes with [scripts/helpIndex/](scripts/helpIndex/). Extension commands write to global storage; refreshing bundled [data/](data/) is a separate, intentional update.
- Follow [parser-upgrade.md](docs/parser-upgrade.md) for WASM updates, recording the upstream revision, toolchain, ABI, and hash.

## Changes and delivery

- Keep changes focused and follow the surrounding style and strict TypeScript settings. Reuse existing helpers; explain non-obvious reasons in comments.
- Update [README.md](README.md) and [README.zh-cn.md](README.zh-cn.md) together when documented user behavior changes. Consult [navigation](docs/navigation.md) and [Hover](docs/hover-information.md) notes for language-feature changes.
- Change versions only as part of a release task: a version change pushed to `main` can trigger the [publishing workflow](.github/workflows/ci.yml) after CI tests pass. Keep the manifest, lockfile, and changelog consistent for releases.
- Report what changed, which checks ran, and any skipped checks or remaining limitations.
