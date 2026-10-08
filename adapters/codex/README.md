# adapters/codex — Codex（Agent Plugins）适配层

**Status: scaffold** — 目前只有可移植清单 `plugin.json` + 一个占位 skill，没有可运行的查看器。

## 路线

| 阶段 | 形态 | 状态 |
| --- | --- | --- |
| ① skill | `skills/file-viewer/SKILL.md`：引导用 `path:line` 引用、让用户在终端跑外部查看器 | 本骨架（当前） |
| ② MCP | 插件根 `mcp.json` 打包 MCP server，复用 `core/`，提供 `open_file_viewer` / `read_file` / `file_diff` | 计划 |
| ③ lifecycle hooks | `hooks/hooks.json`：在会话生命周期事件里触发查看器 / 注入上下文 | 远期；**仅 Codex 桌面手动安装的插件支持**，含 hooks 的插件不进公共插件目录 |

### ① skill（当前）

可移植包从根 `skills/` 目录自动发现 skill，`plugin.json` 不需要声明 `skills` 字段。

### ② mcp.json（计划）

- portable MCP 格式：根 `mcp.json` + Agent Plugins MCP schema + `mcpServers` 下的命名条目，**每个 server 都要写 transport `type`**（不能只把 `.mcp.json` 改个名）。
- server 内部直接复用 `core/`（`tree` / `view_policy` / `git` / `search` / `fuzzy`），三个工具见 `skills/file-viewer/SKILL.md` 的 `TODO(mcp)`。
- 装好后用户可在 Codex 配置里开关该 server、逐工具设审批策略，不需要改插件。

### ③ lifecycle hooks（远期）

- 默认从插件根 `hooks/hooks.json` 发现（或在 `extensions.com.openai.hooks` 显式指定路径，显式值会**替换**默认发现）。
- hook 脚本必须存在于执行环境；命令可拿到 `PLUGIN_ROOT` / `PLUGIN_DATA`（同时设了 `CLAUDE_PLUGIN_ROOT` 兼容变量）。
- 安装/启用插件**不会**自动信任 hooks，用户需要 review 后信任；这类插件不参与公共目录提交。

## 样式：不在插件里

Codex 插件**不能改样式**。主题是配置面：

- `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）里的 `tui.theme`
- 自定义主题是 TextMate `.tmTheme` 文件，放进 `~/.codex/themes/` 后用文件名（kebab-case）引用
- 会话内 `/theme` 可实时预览切换

## 本地安装 / 测试

- repo marketplace：`$REPO_ROOT/.agents/plugins/marketplace.json`，`source.path` 用 `./` 开头、相对 marketplace 根（例如 `./adapters/codex`）
- 个人 marketplace：`~/.agents/plugins/marketplace.json`
- CLI：`codex plugin marketplace add ./<marketplace-root>`、`codex plugin marketplace list`

## 出处

- <https://developers.openai.com/plugins/build/plugins>（打包、`plugin.json` / `mcp.json` / hooks、marketplace）
- <https://developers.openai.com/plugins/build/skills>（skill 写法）
- <https://developers.openai.com/plugins/build/mcp-server>（MCP server）
- <https://developers.openai.com/codex/config-reference>（`tui.theme` 配置面）
