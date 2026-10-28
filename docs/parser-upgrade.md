# GAP parser WASM build

## Bundled binary

The [GAP language WASM](../wasm/tree-sitter-gap.wasm) was built from the
unmodified upstream sources on 2026-10-28:

| Input | Version |
| --- | --- |
| Repository | <https://github.com/gap-system/tree-sitter-gap> |
| Upstream commit | `96fe2e49745ecd62b80cd19dca01fb52b83f93a1` |
| Tree-sitter CLI and runtime | `0.25.10` |
| Emscripten | `4.0.15` |
| Emsdk commit | `389a68bc35dcff7ebae4614e1615099dafda00d1` |
| Build platform | WSL 2, Ubuntu 26.04, Linux x86-64 |
| Language ABI | `15` |
| SHA-256 | `e33b9bad00018755489af4b71a1fe796da2bf292210f7b65f7791e0b9f8eb01e` |

The extension pins `web-tree-sitter` 0.25.10 in the package manifest and lockfile.
The previous ABI 14 binary had SHA-256
`c17fa439c2b86e9356860f581e6ef053094faa9578effc1fc3b31a03f51f906b`;
its original upstream commit and toolchain were not recorded.

## Build in WSL

Git, curl, gzip, Python 3 and a native C compiler are needed. Emsdk supplies its own Node
runtime. Installing the SDK in the user's cache requires no system package
changes or `sudo`. Use a persistent directory: `/tmp` is a memory filesystem in
the audited WSL installation and is cleared when that distribution shuts down.

Run the following in WSL Bash, using a fresh build directory:

```bash
set -euo pipefail
build_root="$HOME/.cache/gap-system-support/wasm-96fe2e4-ts0.25.10"
mkdir -p "$build_root"

git clone https://github.com/gap-system/tree-sitter-gap.git "$build_root/upstream"
git -C "$build_root/upstream" checkout --detach 96fe2e49745ecd62b80cd19dca01fb52b83f93a1

curl -fsSL https://github.com/tree-sitter/tree-sitter/releases/download/v0.25.10/tree-sitter-linux-x64.gz \
  | gzip -dc > "$build_root/tree-sitter"
chmod +x "$build_root/tree-sitter"

git clone --depth 1 --branch 4.0.15 https://github.com/emscripten-core/emsdk.git "$build_root/emsdk"
cd "$build_root/emsdk"
./emsdk install 4.0.15
./emsdk activate 4.0.15
source ./emsdk_env.sh

cd "$build_root/upstream"
"$build_root/tree-sitter" --version
emcc --version
"$build_root/tree-sitter" test
"$build_root/tree-sitter" build --wasm --output "$build_root/tree-sitter-gap.wasm"
sha256sum "$build_root/tree-sitter-gap.wasm"
```

This builds the checked-in `src/parser.c`, `src/scanner.c` and headers. Do not
regenerate or modify the grammar just to retain an older error-recovery shape.
See the [official WASM build instructions](https://github.com/tree-sitter/tree-sitter/blob/v0.25.10/lib/binding_web/README.md#generating-wasm-files)
and [Emsdk installation instructions](https://emscripten.org/docs/getting_started/downloads.html).

Load the staged binary with `web-tree-sitter` 0.25.10, verify ABI 15, and perform
the checks below before copying it over the bundled binary. Then run `npm test`
from the extension's Windows workspace and record the new hash and toolchain.

## Verification and encoding

The native reference parser must use the same grammar, Tree-sitter core version
**and input encoding** as the web runtime. Web Tree-sitter uses UTF-16 input;
the native audit used `ts_parser_parse_string_encoding` with
`TSInputEncodingUTF16LE`. Divide native byte offsets and byte columns by two
before comparing editor offsets and columns.

Using the native CLI's default UTF-8 input can select different recovery paths,
even for ASCII source. Converting UTF-8 offsets after parsing does not eliminate
that difference. Match the input encoding before comparing error trees.

The native/WASM audit covered 1,500 inputs:

- 38 upstream corpus groups, including their intentionally invalid examples.
- 928 single/two-token deletion samples from the diagnostic audit.
- 20 focused cases, including Chinese text, emoji and CRLF.
- 514 GAP 4.16.1 standard-library source files, all with zero diagnostics.

With matching UTF-16LE input, `ERROR`/`MISSING` kinds, tokens, ranges and positions
matched on all inputs. The extension collector preserved every distinct error,
deduplicating only identical-range `ERROR` nodes. Compare `MISSING` insertion
points rather than the expanded visible squiggle ranges. The native reference
used GCC 15.2.0 and Tree-sitter core 0.25.10.
The upstream's 38 native corpus groups, highlighting and tag tests passed.

The larger audit datasets are not bundled in this repository. The ordinary
`npm test` suite covers focused diagnostics, parser recovery and incremental
parsing, highlighting, navigation and tool regressions. Upstream
parity does not imply complete GAP interpreter validation.
