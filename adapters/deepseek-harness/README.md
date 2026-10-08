# adapters/deepseek-harness — DeepSeek Harness（dsh）适配层

**Status: scaffold** — `index.ts` 只有 JSDoc 标注的挂点 + `export default` 空实现，
没有 import 任何 dsh / Cordis API，不编造调用。

## dsh 现状（决定路线的事实）

| 事实 | 对本适配层的意义 |
| --- | --- |
| Cordis 内核，"everything is a plugin"；插件形状是 `name` / `inject` / `apply(ctx)` | 入口按这个形状写，注册一律是 service + scope 挂点 |
| **experimental mods** 可通过 `"band"` 向 input dock 贡献 `Box` / `Text` / `Button` **序列化 UI 树**（用 theme tokens 上色） | 最接近 Claude Code pane / Button / hotkey 的挂点；但是 experimental，细节以 dsh 当前文档为准 |
| skills 支持（`.agents/skills`） | 与 codex skill 同思路，可放引导型占位 |
| **无 MCP 插件打包面**、**无 marketplace**；发现靠 GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin) | 分发 = 自己的仓库 + topic；extension-cookbook 的 feature map 里 MCP 是"一个 server 一个插件注册进 `ctx.tools`"，没有插件级 `mcp.json` 那种打包格式 |
| 版本风险：`@deepseek-ai/dsh` 当前为 `0.2.0-rc.x`，官方标记 developer preview 并明示会有 breaking changes | **experimental / 0.2.x alpha**：骨架不锁 API，等扩展点定稿再实装 |

## 路线（占位，未实装）

1. **service**：`ctx.tools.register(...)` 暴露 `open_file_viewer` / `read_file` / `file_diff`，内部复用 `core/`
2. **scope**：注册走 `ctx.effect(...)`，随插件卸载 / 热重载自动回收
3. **UI**：experimental `"band"` → input dock 的序列化 UI 树（theme tokens）
4. **skills**：`.agents/skills` 下放引导型 skill

> 与 Claude Code mod 的差距：dsh 没有等价的 pane 生命周期 API 可依赖，UI 面先按 experimental 对待。

## 用法

插件尚未接入任何 dsh profile，暂无安装步骤；接入方式（`cordis.patch.yml` profile 层 / `dsh plugin add`）以 dsh 官方文档为准。

## 出处

- <https://github.com/deepseek-ai/deepseek-harness>（规格与仓库，含 `dsh-plugin` topic 说明）
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md>（extension point / 插件形状 / feature→mechanism map）
- <https://github.com/topics/dsh-plugin>（插件发现）
