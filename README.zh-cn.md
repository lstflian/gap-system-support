# GAP System Support

[![License](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE)

[English](README.md) | 简体中文

在 VS Code 中为 GAP 代码提供基于 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) 的语义高亮、代码补全和 GAP 文件运行功能，让 GAP 用户在 VS Code 中便捷地编写、阅读和运行 GAP 代码。

> GAP 是一个面向计算离散代数的系统，尤其擅长计算群论。它提供了一门编程语言和数千个用该语言编写的代数算法函数，并附带大型代数对象数据库。更多信息可见 [GAP 官方网站](https://www.gap-system.org/)。

## 功能演示

### 语法高亮

基于 `tree-sitter-gap` 的语义高亮。

<img src="images/highlight.png" alt="语法高亮演示" width="800" />

### 代码补全

输入时补全 GAP 常量、关键字、语句结构和 GAP 函数，以及光标处可用的变量与自定义函数（含通过 `Read` 加载的其他 GAP 文件中的自定义函数）。

<img src="images/Completion.gif" alt="代码补全演示" width="800" />

### GAP 运行

#### 运行文件

在 VS Code 终端中运行 GAP 文件，点击编辑器右上方的运行按钮即可。

<img src="images/RunGAP.gif" alt="GAP 运行演示" width="800" />

#### 配置命令行选项

可以通过 Quick Pick 配置 GAP 命令行选项。

<img src="images/CommandLineOptions.gif" alt="GAP 命令行选项配置演示" width="800" />

#### 注意事项

运行 GAP 文件时，需要注意以下两点：

1. 运行 GAP 文件需要在终端中能执行 `gap` 命令。
2. 运行 GAP 文件时，终端的 cwd 通过 `vscode.workspace.getWorkspaceFolder(doc.uri)` 获取。该函数返回包含该文件的工作区文件夹；若文件不在任何工作区文件夹内（例如以单文件方式打开），则返回 `undefined`，此时终端不传 cwd，默认在用户主目录启动。详情见 [VS Code API](https://code.visualstudio.com/api/references/vscode-api#workspace.getWorkspaceFolder)。

下面以 Windows 为例，演示如何将 GAP（通过 `.exe` 安装器安装）添加到系统 PATH 中。在 PowerShell 中执行（请将路径替换为实际安装路径）：

```powershell
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
[Environment]::SetEnvironmentVariable('PATH', $userPath + ';C:\Program Files\GAP-4.16.0\runtime\opt\gap-4.16.0;C:\Program Files\GAP-4.16.0\runtime\bin', 'User')
```

重启 PowerShell 后运行 `gap --version` 确认添加成功。

## 设置项

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `gap.runMode` | `reuse` | 终端模式：`new` 每次新建终端，`reuse` 复用同一个 GAP 终端 |
| `gap.terminalRoot` | （空） | Windows 盘符的 Unix 转换根目录。示例：`/` 将 `C:\project\file.g` 转为 `/c/project/file.g`。留空时 WSL 使用默认 `/mnt/` |

## 命令

按 `Ctrl+Shift+P` 打开命令面板可使用以下命令：

| 命令 | 说明 |
|---|---|
| `GAP: Run GAP File` | 在终端中运行当前 GAP 文件 |
| `GAP: Configure GAP Command Line Options` | 通过 Quick Pick 配置 GAP 命令行选项 |
| `GAP: Generate Completion Data` | 用本地 GAP 生成补全数据 |
| `GAP: Reset Completion Data` | 恢复默认补全数据 |


## 开发

首先安装依赖并编译 TypeScript 源码：

```bash
npm install
npm run compile
```

运行测试：

```bash
npm test
```

之后按 `F5` 即可启动调试。

## 致谢

- 语法高亮基于 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap) 的查询文件实现。
- 扩展图标来自 [gap-logo](https://github.com/gap-system/gap-logo)。

## 第三方声明

- 查询文件与语法规则来自 [tree-sitter-gap](https://github.com/gap-system/tree-sitter-gap)（MIT，Copyright (c) 2019 Max Horn，贡献者 Reinis Cirpons）。
- GAP logo 版权归 Max Horn 所有（贡献者 Reinis Cirpons），为 GAP 项目商标，采用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可，衍生作品须以相同许可发布。来源：[gap-logo](https://github.com/gap-system/gap-logo)。
- 完整声明见 [THIRDPARTYNOTICES.md](THIRDPARTYNOTICES.md)。

## 许可证

[MIT](LICENSE)