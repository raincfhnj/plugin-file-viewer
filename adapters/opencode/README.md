# adapters/opencode — OpenCode 适配层

**Status: scaffold** — `plugin.ts` 只注册了一个返回 TODO 的占位 tool，没有实际行为。

## 开发

骨架阶段**未安装依赖**，因此 `tsc` 会报 `Cannot find module '@opencode-ai/plugin'`（`tsconfig.json` 把 `adapters/**` 也 include 了）。先装类型与 `tool()` 帮助函数：

```bash
bun add -d @opencode-ai/plugin
```

安装后本地插件加载位置（启动时自动加载）：

- 项目级：`.opencode/plugins/`
- 全局：`~/.config/opencode/plugins/`

插件要 import 外部运行时包时，按官方文档在配置目录放 `package.json`（OpenCode 启动时会 `bun install`）。

## 路线

| 阶段 | 机制 | 说明 |
| --- | --- | --- |
| ① custom tool | 插件返回 `tool: { open_file_viewer, ... }` | 起外部查看器，或直接返回 core 渲染好的内容（diff / markdown / 源码）—— 当前占位 |
| ② TUI event | `tui.toast.show`、`tui.prompt.append`、`tui.command.execute` | 打开后给提示、注入 `path:line`、触发查看命令 |
| ③ 静态 theme | `~/.config/opencode/themes/*.json`（项目级 `.opencode/themes/`，优先级更高） | **插件无法在运行时改样式**；主题是静态配置面，按 JSON schema 写 token（含 `diff*` / `markdown*` / `syntax*` 键） |

补充：① 之外还有 `tool.execute.before` / `tool.execute.after`、`file.edited`、`session.*` 等事件可用；`tool` 同名时插件工具覆盖内置工具。

## 现状与依赖

```ts
import { tool, type Plugin } from '@opencode-ai/plugin'

export const FileViewerPlugin: Plugin = async (ctx) => ({
  tool: { open_file_viewer: tool({ ... }) },
})
```

- 入口导出：`FileViewerPlugin`
- `core/` 是唯一事实源：实现 ① 时在 `execute` 里构造 `Host`（`node:fs` + `child_process`）并调用 core，不复制 core 逻辑。

## 出处

- <https://opencode.ai/docs/plugins/>（插件结构、`tool()`、TUI events）
- <https://opencode.ai/docs/themes/>（主题 JSON 与加载目录）
- <https://opencode.ai/docs/custom-tools/>（不用插件注册自定义工具的替代路径）
