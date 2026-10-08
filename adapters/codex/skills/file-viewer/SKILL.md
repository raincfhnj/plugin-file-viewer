---
name: file-viewer
description: 在仓库里定位文件并给出 path:line 引用，引导用户用只读的 git-aware 文件查看器浏览树与 diff。当用户要求 open/view/browse/inspect 文件、查看改动文件的 diff、或给出 path:line 让你跳转时使用。
---

# file-viewer

> **Status: scaffold** — 这是阶段 ① 的占位 skill。交互式查看器尚未随本插件打包，
> 路线与出处见 `adapters/codex/README.md`。

## 现在能做什么（阶段 ①：引导）

本插件当前没有 MCP 工具，只做两件事：

1. **所有文件引用统一写成 `path:line`**
   - 形如 `src/file.ts:42`：仓库根相对路径、POSIX 分隔符；core 的 `parseFileRef()` 就是这个语法。
   - 代码定位、报错回溯、跨文件跳转一律先给出 `path:line`，用户和后续工具都能直接消费。

2. **需要肉眼浏览时，引导用户在终端跑外部查看器**
   - 明确告诉用户在另一个终端打开文件查看器，并给出目标路径 / 行号。
   - 不要假装插件自己能打开面板 —— Claude Code 侧才有 `/files` 命令，Codex 侧要等阶段 ②。

## TODO(mcp)

阶段 ② 会在插件根放置 `mcp.json`，打包复用 `core/` 的 MCP server，暴露：

- `open_file_viewer(path?, line?)` — 打开查看器并定位到文件 / 行
- `read_file(path)` — 按 view policy 返回 diff、渲染后的 markdown 或带高亮的源码
- `file_diff(path, baseline)` — `HEAD` 或 `Base` 基线下的只读 diff

在阶段 ② 落地前，本 skill 不提供任何工具调用。

## 约定

- 只读：查看器不写文件；git 只跑带安全 flag 的只读命令。
- 路径：仓库根相对、POSIX 分隔；宿主绝对路径（含 Windows）由适配层转换。
