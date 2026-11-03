# GAP System Support

[![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

English | [简体中文](README.zh-cn.md)

This extension provides intelligent code editing powered by [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap), GAP code running, and a help system in VS Code, along with GAP-specific language model tools and MCP support, so that GAP users can easily write, read, and run GAP code and look up GAP help documentation at any time. The recognized GAP file extensions are `.g`, `.gi`, `.gd`, and `.gap`.

> GAP is a system for computational discrete algebra, with particular emphasis on Computational Group Theory. GAP provides a programming language, a library of thousands of functions implementing algebraic algorithms written in the GAP language as well as large data libraries of algebraic objects. For more information, see the [GAP official website](https://www.gap-system.org/).

## Main Features

- **Semantic highlighting and syntax diagnostics**: based on `tree-sitter-gap`.
- **Code completion**: provides completion for GAP constants, keywords, statement structures, and GAP functions (including functions from other GAP files loaded via `Read`).
- **Hover information**: hovering over a symbol shows its static category, such as `function`, `variable`, `parameter`, or `record field`. Built-in functions show their signatures; once the GAP documentation paths are configured, a short documentation summary and a GAP help link are also shown.
- **Definition navigation**: native Go to Definition and Peek Definition support for statically recognizable user-defined GAP symbols.
- **Reference navigation**: use `Command+click` on macOS or `Ctrl+click` on Windows/Linux; definitions with references open the native Peek view, and native Find All References (`Shift+F12`) is also available. Results exclude the clicked occurrence; if there are no references, navigation goes directly to the definition itself.
- **Running GAP code**: runs the current GAP file in the VS Code integrated terminal, with configurable GAP command line options.
- **Help system**: built-in GAP help search with two search modes (switchable at any time in the settings or the Quick Pick search box), with results filterable by book.
  - **prefix**: same behavior as `?topic` in GAP
  - **substring**: same behavior as `??topic` in GAP
- **Documentation viewer**: search results are displayed in a webview panel.
- **Language model tools and MCP**: GAP-related tools for agents in chat.

## Getting Started

### 1. Install GAP

This extension requires GAP to be installed locally; see [Installing GAP](https://www.gap-system.org/install/).

### 2. Detect GAP and Configure Documentation Paths

Click **Detect GAP Installation** in the walkthrough, or run **GAP: Detect GAP Installation** from the Command Palette. If GAP is not found, click **Select GAP Folder** in the notification to select the installation folder manually. If the extension finds `doc/` or `pkg/`, click **Use Detected Folders** in the notification to fill the corresponding empty settings; existing paths will not be overwritten. If documentation or packages are installed elsewhere and are not detected, enter their actual paths manually in the extension settings.

Each path must point to the folder itself; the paths below are only examples:

- `gap.docPath`: the absolute path of the `doc/` folder, for example:
  - Windows: `C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1\doc`
  - Linux/macOS: `/opt/gap-4.16.1/doc`
- `gap.pkgPath`: the absolute path of the `pkg/` folder, for example:
  - Windows: `C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1\pkg`
  - Linux/macOS: `/opt/gap-4.16.1/pkg`

## Language Model Tools and MCP

| Tool | Purpose |
| --- | --- |
| `gapSearchHelp` | Searches the GAP help index and returns the file locations of matching entries |
| `gapListBooks` | Lists all GAP help book short names |
| `gapResolveLink` | Resolves a relative link in a GAP help file to its absolute path and target line |
| `gapCheckSyntax` | Statically checks a GAP source file for syntax errors using tree-sitter-gap |
| `gapRunFile` | Runs one GAP file with `-q --nointeract` and redirects output to the specified file; optional `cwd` overrides the working directory for this invocation |

- **Language model tools**: available to agents in VS Code, controlled by `gap.tools.enabled` and enabled by default.
- **MCP server**: controlled by the user setting `gap.mcp.enabled` and disabled by default. VS Code starts the server on demand as a local stdio process using the current window's GAP settings. Other MCP clients can also run the same server: **GAP: Copy MCP Server Configuration** copies its stdio launch configuration. Copy it again after updating the extension or changing GAP settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gap.docPath` | `""` | Absolute path of the `doc/` directory |
| `gap.pkgPath` | `""` | Absolute path of the `pkg/` directory |
| `gap.docAppearance` | `system` | Documentation appearance: `system` follows the VS Code theme, `dark` / `light` use a dark or light theme |
| `gap.mathJax` | `true` | Whether to render MathJax math in GAP documentation pages |
| `gap.runMode` | `reuse` | When running GAP: `reuse` keeps the same terminal, `new` opens a new terminal for each run |
| `gap.terminalRoot` | `""` | Unix root for Windows drive letters. Example: `/` turns `C:\project\file.g` into `/c/project/file.g`; leave empty to use the WSL default `/mnt/` |
| `gap.searchMode` | `prefix` | Search mode: `prefix` corresponds to `?topic`, `substring` corresponds to `??topic` |
| `gap.diagnostics` | `true` | Show syntax error diagnostics from the GAP parser in the Problems panel |
| `gap.tools.enabled` | `true` | Provide native VS Code language model tools; independent of MCP |
| `gap.mcp.enabled` | `false` | User setting: provide the GAP stdio MCP server to VS Code in trusted workspaces; independent of native tools |

## Commands

Press `Ctrl+Shift+P` or `F1` to open the Command Palette and use the following commands:

| Command | Description |
| --- | --- |
| `GAP: Detect GAP Installation` | Rescan common locations and select an installation |
| `GAP: Select GAP Installation` | Select a folder and remember its validated installation locally |
| `GAP: Run GAP File` | Available when a GAP file is open; run the current GAP file in a terminal |
| `GAP: Configure GAP Command Line Options` | Configure GAP command line options through Quick Pick |
| `GAP: Search GAP Help` | Search GAP help documentation |
| `GAP: Rebuild Help Index` | Rebuild the help index |
| `GAP: Open GAP Reference Manual` | Open the GAP Reference Manual |
| `GAP: Generate Completion Data` | Regenerate the completion data |
| `GAP: Reset Completion Data` | Restore the default completion data |
| `GAP: Copy MCP Server Configuration` | Copy the stdio launch configuration of the GAP MCP server for other MCP clients |

The run, help, and completion data commands are also available in the editor context menu (right-click menu) of GAP files, where `GAP: Search GAP Help` and `GAP: Run GAP File` are at the top level, while the remaining commands are grouped in the **More GAP Commands** submenu. The MCP configuration command is available from the Command Palette only.

## Development

Implementation and coverage notes:

- [Definition and reference navigation](docs/navigation.md)
- [Definition navigation coverage](docs/definition-navigation-coverage.md)
- [Hover information](docs/hover-information.md)

First, install the dependencies and compile the TypeScript sources:

```bash
npm install
npm run compile
```

Run the tests:

```bash
npm test
```

For manual testing in an Extension Development Host or a local VS Code installation, build a VSIX:

```bash
npx @vscode/vsce package
```

Then press `F5` to start debugging.

## Acknowledgements

- Syntax highlighting is implemented based on the [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) query files.
- The extension icon is from [gap-logo](https://github.com/gap-system/gap-logo).
- Thanks to [@JieteXue](https://github.com/JieteXue) for contributing to this project, and to everyone who has supported its development.

## Third Party Notices

- The query files and grammar rules are from [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) (MIT, Copyright (c) 2019 Max Horn, contributor Reinis Cirpons).
- The GAP logo is © Max Horn (contributor Reinis Cirpons) and a trademark of the GAP project, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Derivatives must be shared under the same license. See [gap-logo](https://github.com/gap-system/gap-logo).
- See [THIRDPARTYNOTICES.md](THIRDPARTYNOTICES.md) for the full notices.

## License

[MIT](LICENSE)
