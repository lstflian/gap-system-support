# GAP System Support

[![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

English | [简体中文](README.zh-cn.md)

This extension provides semantic highlighting, code completion, syntax diagnostics, hover hints, code folding, running GAP files, and a help system for GAP in VS Code, powered by [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap), so that GAP users can write, read, and run GAP code and look up GAP documentation at any time. The file extensions recognized as GAP are `.g`, `.gi`, `.gd`, and `.gap`.

> GAP is a system for computational discrete algebra, with particular emphasis on Computational Group Theory. GAP provides a programming language, a library of thousands of functions implementing algebraic algorithms written in the GAP language as well as large data libraries of algebraic objects. For more information, see the [GAP official website](https://www.gap-system.org/).

## Features

- **Semantic highlighting**: based on `tree-sitter-gap`.
- **Code folding**: folding ranges follow the syntax structure (for example, `if ... fi`, `function ... end`).
- **Syntax diagnostics**: missing required syntax and unexpected syntax are reported in the Problems panel while you type.
- **Hover hints**: hovering over a function name shows a help link for GAP functions; for user defined functions it shows the definition line and the `##` comments, with a jump to the definition (including files loaded via `Read`).
- **Code completion**: provides completion for GAP constants, keywords, statement structures, and GAP functions, while also suggesting the variables and user defined functions visible at the cursor (including functions from other GAP files loaded via `Read`).
- **Running GAP code**: runs the current GAP file in the VS Code integrated terminal, with configurable GAP command line options and terminal reuse.
- **Help system**: built-in GAP help search with two search modes (switchable at any time in the settings or the Quick Pick search box), and filtering the results by book.
  - **prefix**: corresponds to `?topic` in GAP
  - **substring**: corresponds to `??topic` in GAP
- **Documentation viewer**: search results are displayed in a webview panel, with support for in-page link navigation, MathJax rendering, and light or dark documentation appearance.

## Getting Started

### 1. Install GAP and Configure the PATH

First, make sure GAP is installed and added to the system `PATH`. If it is not on the `PATH`, you can follow the steps below to configure it.

**Windows**: If GAP was installed via the `.exe` installer, run the following in PowerShell:

```powershell
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', $userPath + ';C:\Program Files\GAP-4.16.0\runtime\opt\gap-4.16.0;C:\Program Files\GAP-4.16.0\runtime\bin', 'User')
```

After running the commands above, open a new PowerShell terminal and run `gap --version`. If it prints the GAP version, your environment is configured successfully.

**Linux / macOS**: Run the following in a terminal (on macOS, replace `~/.bashrc` with `~/.zshrc`):

```bash
echo 'export PATH="/opt/gap-4.16.0:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Finally, run `gap --version` to verify that it is configured correctly.

**Note**: If your installation path differs from the examples, replace it with your actual installation path.

### 2. Set the GAP Documentation Paths in the Extension Settings

Set the following settings in the walkthroughs on the Welcome page or in the VS Code extension settings:

- `gap.docPath`: the absolute path of the `doc/` folder, for example:
  - Windows: `C:\Program Files\GAP-4.16.0\runtime\opt\gap-4.16.0\doc`
  - Linux/macOS: `/opt/gap-4.16.0/doc`
- `gap.pkgPath`: the absolute path of the `pkg/` folder, for example:
  - Windows: `C:\Program Files\GAP-4.16.0\runtime\opt\gap-4.16.0\pkg`
  - Linux/macOS: `/opt/gap-4.16.0/pkg`

## Feature Demos

### 1. Syntax Highlighting and Code Completion

<img src="./images/highlight-comp.png" alt="Syntax highlighting and code completion demo" />

### 2. Help Search System

<img src="./images/help-search.webp" alt="Help search system demo" />

### 3. Running GAP and Configuring Command Line Options

<img src="./images/run-gap.webp" alt="Running GAP and configuring command line options demo" />

> Note: `vscode.workspace.getWorkspaceFolder(doc.uri)` determines the terminal cwd when running a GAP file.
> For a single-root workspace, cwd is set to the workspace root folder;
> for a multi-root workspace, cwd is set to the workspace root folder that contains the GAP file (for nested roots, the innermost root folder is returned);
> if the GAP file is not in any workspace, no cwd is specified and the terminal uses the VS Code default directory.
> See the [VS Code API](https://code.visualstudio.com/api/references/vscode-api#workspace.getWorkspaceFolder) for more information.

## Settings

| Setting | Default | Description |
|---|---|---|
| `gap.docPath` | `""` | Manually enter the absolute path of the `doc/` directory |
| `gap.pkgPath` | `""` | Manually enter the absolute path of the `pkg/` directory |
| `gap.docAppearance` | `system` | Documentation appearance: `system` follows the VS Code theme, `dark` / `light` use a dark or light theme |
| `gap.mathJax` | `true` | Whether to render MathJax math in GAP documentation pages |
| `gap.runMode` | `reuse` | When running GAP: `reuse` keeps the same terminal, `new` opens a new terminal for each run |
| `gap.terminalRoot` | `""` | Unix root for Windows drive letters. Example: `/` turns `C:\project\file.g` into `/c/project/file.g`; leave empty to use the WSL default `/mnt/` |
| `gap.searchMode` | `prefix` | Search mode: `prefix` corresponds to `?topic`, `substring` corresponds to `??topic` |
| `gap.diagnostics` | `true` | Show syntax error diagnostics (missing/expected tokens, unexpected syntax) from the GAP parser in the Problems panel |

## Commands

Press `Ctrl+Shift+P` or `F1` to open the Command Palette and use the following commands:

| Command | Description |
|---|---|
| `GAP: Run GAP File` | Available when a GAP file is open; run the current GAP file in a terminal |
| `GAP: Configure GAP Command Line Options` | Configure GAP command line options through Quick Pick |
| `GAP: Search GAP Help` | Search GAP help documentation |
| `GAP: Rebuild Help Index` | Rebuild the help index |
| `GAP: Open GAP Reference Manual` | Open the GAP Reference Manual |
| `GAP: Generate Completion Data` | Regenerate the completion data |
| `GAP: Reset Completion Data` | Restore the default completion data |

These commands are also available in the editor context menu (right-click menu) of GAP files for quick access.

## Development

First, install the dependencies and compile the TypeScript sources:

```bash
npm install
npm run compile
```

Run the tests:

```bash
npm test
```

Then press `F5` to start debugging.

## Acknowledgements

- Syntax highlighting is implemented based on the [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) query files.
- The extension icon is from [gap-logo](https://github.com/gap-system/gap-logo).

## Third Party Notices

- The query files and grammar rules are from [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) (MIT, Copyright (c) 2019 Max Horn, contributor Reinis Cirpons).
- The GAP logo is © Max Horn (contributor Reinis Cirpons) and a trademark of the GAP project, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Derivatives must be shared under the same license. See [gap-logo](https://github.com/gap-system/gap-logo).
- See [THIRDPARTYNOTICES.md](THIRDPARTYNOTICES.md) for third-party notices.

## License

[MIT](LICENSE)