# adapters/opencode — OpenCode 适配层

**Status: implemented (v0.1)** — 真实 server 插件，注册 4 个只读工具（`file_tree` / `file_diff` / `file_search` / `content_search`），全部复用 `core/`（tree / git / fuzzy / search / view_policy），无复制逻辑。
已验证：单测 22 绿、`tsc` 绿、`opencode debug info` 加载、`opencode serve` 工具注册。

## 工具

| tool | args | 返回 | 复用的 core |
| --- | --- | --- | --- |
| `file_tree` | `path?`（repo 相对起始目录）、`depth?`（1–10，默认 3，changed_only 时忽略）、`changed_only?` | 缩进树文本：状态记号 `M/A/D/?`、目录 `▸/▾`、含变更目录后缀 `~`、图例行 | `tree.listRows` + `git.status`（repo root 来自 `git rev-parse --show-toplevel`） |
| `file_diff` | `path`、`baseline?: 'HEAD' \| 'Base'`（默认 HEAD）、`full?`（整文件上下文） | unified diff + `view_policy` 提示行（`view=` 初始视图、`modes=` 可切换周期） | `git.fileDiff`（untracked → `--no-index`、unborn HEAD → 空树）+ `view_policy.describeFile/applicableModes` |
| `file_search` | `query` | `score  path` 逐行，按分排序（basename 命中 > 目录命中 > 短路径），最多 50 条 | `fuzzy.fuzzyFilter` |
| `content_search` | `query`、`limit?`（默认 100，≤500） | `path:line: text` 逐行 | `search.searchContent` |

共同契约：

- **只读**：不写盘、不写索引；git 全部走 `execFile('git', argv)` 无 shell，携带 `SAFE_GIT_FLAGS`（`core.fsmonitor=`、`core.hooksPath=NUL`）+ `SAFE_GIT_ENV`（`GIT_OPTIONAL_LOCKS=0`），diff 另加 `SAFE_DIFF_FLAGS`，30s 超时。
- **root 解析**：`host.ts resolveRepo(ctx.directory)` → `repoRoot()` 有仓库则以 toplevel 为根（非仓库回退 session 目录，`git=no`，status/diff 降级为空）。
- **路径**：Windows 反斜杠在 `host.ts` 归一为 POSIX，core 内全程 repo 相对 POSIX 路径。
- **输出**：`{ title, output }`；`output` > 50 KiB 截断并附 `… [truncated: kept N of M chars]`。
- **每个 execute 自建 Host**（无跨会话缓存，避免陈旧 status）。

## 安装 / 加载

```bash
# 依赖装在仓库根（插件文件的裸导入从文件位置向上解析；本机无 bun，npm 即可）
npm install --save-dev @opencode-ai/plugin   # 自带 zod4，确认 node_modules/@opencode-ai/plugin/dist/tool.d.ts 存在
```

加载（二选一，已用第一种）：

1. 仓库根 `opencode.json`：`{ "plugin": ["./adapters/opencode/plugin.ts"] }`（相对路径，`opencode debug config` 显示 `source=opencode.json, scope=local`）；
2. `.opencode/plugins/*.ts`（只扫一层；全局 `~/.config/opencode/plugins/` 同理）。

**无热重载**：改 `plugin.ts` 后必须重开 opencode 进程才能生效。

## 验证命令

```bash
npm run test:opencode        # node --test adapters/opencode/tests/*.test.ts（fake Host 单测 + 真仓库端到端）
npm test                     # core 单测（99 pass）
npx tsc -p adapters/opencode/tsconfig.json --noEmit   # 本适配层 → exit 0
npx tsc --noEmit             # 根 tsconfig；opencode + core 0 错（剩余错误全在 adapters/claude-code，见下）

opencode debug info          # plugins: file:///D:/.../adapters/opencode/plugin.ts
opencode debug config        # plugin_origins: source=.../opencode.json, scope=local

# 可选：验证 4 个工具真的注册进 server
opencode serve --port 47831
# GET http://127.0.0.1:47831/experimental/tool/ids?directory=D:\1024\my\plugin-file-viewer
# → [...内置工具..., "file_tree", "file_diff", "file_search", "content_search"]
```

关于根 `npx tsc --noEmit` 的残留错误（全部位于 `adapters/claude-code/**`，不在本适配层范围）：TS 的 `include` 通配**不进入以 `.` 开头的目录**，因此根程序看不到 `.claude-plugin/types/` 里 `declare module 'claude-code'` 的声明 → 该适配层按自己的 `adapters/claude-code/tsconfig.json`（`extends ./.claude-plugin/types/tsconfig.json`）检查，根检查对它本来就不是权威入口。`adapters/opencode/**` 与 `core/**` 在根检查下 0 错。

类型环境说明：本机 `npx tsc` 是 TS 7（tsgo），**不会自动包含 `node_modules/@types`**（core 旧测试文件也会因此报 TS2591）。两处最小修复都在本适配层内：`host.ts` 顶部 `/// <reference types="node" />`（让根检查把 `@types/node` 拉进整个程序）+ 局部 `adapters/opencode/tsconfig.json` 的 `"types": ["node"]`。根 `tsconfig.json` 未改动。

## loader 坑（opencode 1.18.35 / v1 插件 API 实测）

1. **default 必须是函数**（`async ({ client, directory, worktree, $ }) => hooks`）或 `{ id, server }` 对象；本插件用函数形态。
2. **default 是函数时，该模块所有运行时导出值都必须是函数或 `{server}` 对象**，否则报 `Plugin export is not a function`。→ `plugin.ts` 只导出 `default`（type-only 导出会被 TS 转换擦除）；helper 放在 `host.ts` / `tools.ts`，只 import 不 re-export。测试文件是独立模块，不受此规则约束（`tests/plugin.test.ts` 有专门的导出规则自检）。
3. 裸导入（`@opencode-ai/plugin`、`zod`）从插件文件向上解析 → 依赖必须装在**仓库根**，装在别处加载即失败。
4. 无热重载：改完要重开进程；日志 `%USERPROFILE%\.local\share\opencode\log\opencode.log`（查 `failed to load plugin` / `Plugin export isnot a function`）。

## 与 claude-code 能力对照

| 能力 | claude-code mod（本仓库） | OpenCode server 插件（本适配层） |
| --- | --- | --- |
| tree / diff / markdown / code **pane**（Box+Text 绘制、滚动、选中） | ✅ `$.ui.open` + `ui.render` | ❌ **没有 pane / UI API**，只能把文本交给模型 |
| `/files` 命令 | ✅ `$.command.register` | ❌ 无自定义命令注册 |
| toast / prompt 提示 | 直接 UI | 只能经 server 的 **`/tui/*` HTTP 端点**（`/tui/show-toast`、`/tui/append-prompt`、`/tui/execute-command` 等）经 SDK client 触发，能力有限 |
| 模型可直接调用的工具 | 间接（hook 包装） | ✅ `tool()` 注册，4 个工具进模型 tool 列表 |
| 状态存储 / 热刷新 | `$.store` + `scheduleRefresh` | ❌ 每次 execute 重算；无热重载 |
| 会话/事件 hook | `session.*`、`tool.call`… | v1 `event` / `tool.execute.*` / `experimental.chat.system.transform` 等（本版**未挂**，见 future work） |

## 修正旧 README 的结论（主题 / 样式）

- ✅ 成立的部分：**server 插件确实不能改样式** —— v1 `Hooks` 里没有任何 theme/UI 接口，样式面只能靠静态主题文件（`~/.config/opencode/themes/`、项目级 `.opencode/themes/`）。
- ❌ 需要修正的部分：“插件无法在运行时改样式”过于绝对。v1 除 server 插件外还有 **TUI 插件**（`tui.json` 的独立入口，与 server 插件并列），其插件上下文带 `theme: TuiTheme`，可用 **`api.theme.install(jsonPath)` / `api.theme.set(name)` 运行时安装、切换主题**（类型真源 `@opencode-ai/plugin/dist/tui.d.ts` 的 `TuiTheme`）。即：静态主题 JSON schema（含 `diff*` / `markdown*` / `syntax*` 键）仍然有效，但“只能重启才生效”只对 server 插件/纯配置面成立。

→ **future work**：① TUI 插件入口（`tui.json`）+ `theme.install/set` 运行时换主题；② `tool.execute.after` 或 `experimental.chat.system.transform` 挂一条轻量提示，引导模型优先用这 4 个工具（本版刻意不挂，保持插件零副作用、加载面最小）；③ 经 `/tui/show-toast` 在树/diff 更新后给 UI 提示。

## 测试

```bash
npm run test:opencode
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/tools.test.ts` | fake Host + 脚本化 git：`rowLabel` 与 pane 逐字节一致、`toRel`/`fit`、树 depth/changed_only/dirDirty/图例、diff 的 HEAD/Base/full/untracked/删除/无改动/找不到路径/view 提示、fuzzy 排序（basename > 目录命中）、`path:line:` 行格式与 hidden/node_modules/非文本跳过、limit |
| `tests/host.test.ts` | 真实 fs（list/read/exists）+ 真实只读 git（`rev-parse`，`SAFE_GIT_FLAGS` 生效）、`resolveRepo` 以 toplevel 为根 |
| `tests/plugin.test.ts` | loader 导出规则自检（只有函数导出）、4 工具注册与 schema、经 default 导出在**真仓库**端到端执行 4 个工具 |

## 出处

- 类型真源（本机）：`node_modules/@opencode-ai/plugin/dist/{index.d.ts,tool.d.ts,tui.d.ts}`
- <https://opencode.ai/docs/plugins/>（v1 插件形态、`tool()`、hooks）
- <https://opencode.ai/docs/themes/>（主题加载目录；TUI 插件 API 见 `tui.d.ts`）
