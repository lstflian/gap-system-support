# GAP System Support

[![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

[English](README.md) | 简体中文

在 VS Code 中为 GAP 提供基于 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) 的智能代码编辑、GAP 代码运行和帮助系统，并额外提供针对 GAP 的语言模型工具和 MCP 支持，让 GAP 用户能便捷地编写、阅读和运行 GAP 代码，并随时查询 GAP 帮助文档。扩展可识别的 GAP 文件扩展名为：`.g`、`.gi`、`.gd`、`.gap`。

> GAP 是一个面向计算离散代数的系统，尤其侧重于计算群论。它提供了一门编程语言和数千个用该语言编写的代数算法函数，并附带大型代数对象数据库。更多信息可见 [GAP 官方网站](https://www.gap-system.org/)。

## 主要功能说明

- **语义高亮与语法诊断**：基于 `tree-sitter-gap`。
- **代码补全**：提供 GAP 常量、关键字、语句结构和 GAP 函数的补全（包括通过 `Read` 加载的其他 GAP 文件中的函数）。
- **悬停信息**：将鼠标悬停在符号上时，会显示其静态类别，例如 `function`、`variable`、`parameter` 或 `record field`。内置函数会显示函数签名；配置 GAP 文档路径后，还会显示简短的文档摘要和 GAP 帮助链接。关键字、运算符和语句终止符 `;` 会在 Hover 中以语法高亮代码片段显示，并附带简短说明。
- **定义导航**：为可静态识别的 GAP 自定义符号提供 VS Code 原生的转到定义与 Peek Definition。
- **引用导航**：在 macOS 上使用 `Command+点击`，在 Windows/Linux 上使用 `Ctrl+点击`；有引用的定义会打开原生 Peek，也可使用原生的查找所有引用（`Shift+F12`）。结果不包含当前点击的这一条，没有引用时直接跳转到定义自身。
- **运行 GAP 代码**：在 VS Code 集成终端中运行当前 GAP 文件，并支持配置 GAP 命令行选项。
- **帮助系统**：内置 GAP 帮助搜索，支持两种搜索模式（可在设置或 Quick Pick 搜索框中随时切换），并可按书籍（books）过滤结果。
  - **prefix**：对应 GAP 中的 `?topic`
  - **substring**：对应 GAP 中的 `??topic`
- **帮助文档浏览**：搜索结果会在 Webview 面板中展示。
- **语言模型工具与 MCP**：为对话中的 agents 提供 GAP 帮助查询与语法检查工具。

## 快速开始

### 1. 安装 GAP 并配置 PATH

先确认 GAP 已经安装成功并且已经添加到系统 `PATH`。如果未添加到 `PATH`，则可以参考下面的步骤进行配置。

**Windows**：如果 GAP 是通过 `.exe` 安装器安装的，则可以在 PowerShell 中执行：

```powershell
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', $userPath + ';C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1;C:\Program Files\GAP-4.16.1\runtime\bin', 'User')
```

执行完上述命令后，重新打开一个 PowerShell 终端，运行 `gap --version`，如果能正常输出 GAP 版本号，说明环境已配置成功。

**Linux / macOS**：在终端运行以下命令（macOS 请将 `~/.bashrc` 换成 `~/.zshrc`）：

```bash
echo 'export PATH="/opt/gap-4.16.1:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

最后运行 `gap --version` 验证。

**注意**：如果安装路径与示例不同，请替换为实际安装路径。

### 2. 在扩展设置中配置 GAP 文档路径

在欢迎页面的入门引导（walkthrough）或 VS Code 的扩展设置中填写以下设置项：

- `gap.docPath`：`doc/` 文件夹的绝对路径，例如：
  - Windows: `C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1\doc`
  - Linux/macOS: `/opt/gap-4.16.1/doc`
- `gap.pkgPath`：`pkg/` 文件夹的绝对路径，例如：
  - Windows: `C:\Program Files\GAP-4.16.1\runtime\opt\gap-4.16.1\pkg`
  - Linux/macOS: `/opt/gap-4.16.1/pkg`

## 语言模型工具与 MCP

| 工具 | 用途 |
| --- | --- |
| `search_gap_help` | 搜索 GAP 帮助索引并返回匹配条目的文件位置 |
| `list_gap_books` | 列出所有 GAP 帮助书籍（books）的简称 |
| `gap_resolve_link` | 将 GAP 帮助文件中的相对链接解析为绝对路径和目标行 |
| `check_gap_syntax` | 使用 tree-sitter-gap 静态检查 GAP 源文件的语法错误 |
| `run_gap_file` | 运行一个 GAP 文件，并将输出重定向到指定文件 |

两种入口提供相同的五个工具，开关互不影响。

- **语言模型工具**：供 VS Code 内的 agent 调用，由 `gap.tools.enabled` 控制，默认开启。
- **MCP 服务**：供 VS Code 和外部 MCP 客户端调用，由 `gap.mcp.enabled` 控制，默认关闭。

在受信任工作区开启 MCP 后，可运行 **GAP: Copy MCP Connection Configuration** 获取外部客户端的连接配置。

## 设置项

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `gap.docPath` | `""` | 手动填写 `doc/` 目录绝对路径 |
| `gap.pkgPath` | `""` | 手动填写 `pkg/` 目录绝对路径 |
| `gap.docAppearance` | `system` | 文档外观，`system` 跟随 VS Code 主题，`dark` / `light` 使用深色或浅色主题 |
| `gap.mathJax` | `true` | 是否在 GAP 文档页面中渲染 MathJax 数学公式 |
| `gap.runMode` | `reuse` | 运行 GAP 时，`reuse` 复用同一个终端，`new` 每次新建终端 |
| `gap.terminalRoot` | `""` | Windows 盘符对应的 Unix 根目录。示例：`/` 会把 `C:\project\file.g` 转成 `/c/project/file.g`；留空时 WSL 默认使用 `/mnt/` |
| `gap.searchMode` | `prefix` | 搜索模式，`prefix` 对应 `?topic`，`substring` 对应 `??topic` |
| `gap.diagnostics` | `true` | 在问题面板显示 GAP 解析器产生的语法错误诊断 |
| `gap.tools.enabled` | `true` | 提供原生 VS Code 语言模型工具，与 MCP 开关独立 |
| `gap.mcp.enabled` | `false` | 在受信任工作区自动启动带认证的本机 MCP 服务，与原生工具开关独立 |
| `gap.mcp.port` | `0` | MCP 端口；`0` 自动分配，指定固定端口被占用时明确报错，支持用户和工作区设置 |

## 命令

按 `Ctrl+Shift+P` 或 `F1` 打开命令面板，即可使用以下命令：

| 命令 | 说明 |
| --- | --- |
| `GAP: Run GAP File` | 当打开 GAP 文件时可用，在终端中运行当前 GAP 文件 |
| `GAP: Configure GAP Command Line Options` | 通过 Quick Pick 配置 GAP 命令行选项 |
| `GAP: Search GAP Help` | 搜索 GAP 帮助文档 |
| `GAP: Rebuild Help Index` | 重新生成帮助索引 |
| `GAP: Open GAP Reference Manual` | 打开 GAP 参考手册 |
| `GAP: Generate Completion Data` | 重新生成补全数据 |
| `GAP: Reset Completion Data` | 恢复默认补全数据 |
| `GAP: Copy MCP Connection Configuration` | 复制正在运行的 MCP 服务地址和私有认证 header |
| `GAP: Reset MCP Access Token` | 更换当前 VS Code Profile 下所有工作区共享的持久化令牌 |

运行、帮助和补全数据命令也会出现在 GAP 文件的编辑器上下文菜单（右键菜单）中，其中 `GAP: Search GAP Help` 和 `GAP: Run GAP File` 位于菜单顶层，其余命令聚合在 **More GAP Commands** 子菜单中。MCP 连接配置和令牌重置命令仅在命令面板中提供。

## 开发

实现与覆盖范围文档：

- [定义与引用导航](docs/navigation.md)
- [定义导航覆盖范围](docs/definition-navigation-coverage.md)
- [Hover 信息](docs/hover-information.md)

首先安装依赖并编译 TypeScript 源码：

```bash
npm install
npm run compile
```

运行测试：

```bash
npm test
```

如需在扩展开发主机或本地 VS Code 中手动测试，可以构建 VSIX：

```bash
npx @vscode/vsce package
```

之后按 `F5` 即可启动调试。

## 致谢

- 语法高亮基于 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) 的查询文件实现。
- 扩展图标来自 [gap-logo](https://github.com/gap-system/gap-logo)。
- 感谢 [@JieteXue](https://github.com/JieteXue) 对本项目的贡献，以及所有支持本项目开发的人。

## 第三方声明

- 查询文件与语法规则来自 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap)（MIT，Copyright (c) 2019 Max Horn，贡献者 Reinis Cirpons）。
- GAP logo 版权归 Max Horn 所有（贡献者 Reinis Cirpons），为 GAP 项目商标，采用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可，衍生作品须以相同许可发布。来源：[gap-logo](https://github.com/gap-system/gap-logo)。
- 完整声明见 [THIRDPARTYNOTICES.md](THIRDPARTYNOTICES.md)。

## 许可证

[MIT](LICENSE)
