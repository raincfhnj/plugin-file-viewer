# plugin-file-viewer

跨 harness 的 **git-aware 只读文件查看器**：从 Rust/TUI 项目 [herdr-file-viewer](https://github.com/smarzban/herdr-file-viewer) 移植核心逻辑，`core/` 是平台无关的 TypeScript 实现，`adapters/` 把它分别接到 Claude Code / Codex / OpenCode / DeepSeek Harness 上。

## 架构

```
                    adapters/claude-code   ✅ 已实装 (v0.1)
                              │
    adapters/codex  📁 骨架 ──┼── adapters/opencode  📁 骨架
                              │
                    ┌─────────▼─────────┐
                    │      core/        │   平台无关 TS · 零依赖
                    │  single source of │   types / host / git / tree
                    │      truth        │   view_policy / fuzzy / search
                    └─────────▲─────────┘
                              │
              adapters/deepseek-harness  📁 骨架
```

`core/` 只做纯逻辑 + `Host` I/O 接口，不 import `node:*`；每个 adapter 负责把自己的宿主能力（fs / 进程 / UI）实现成 `Host`。

## 状态

| 适配层 | harness | 状态 | 入口 |
| --- | --- | --- | --- |
| [`adapters/claude-code/`](adapters/claude-code/) | Claude Code（mods） | **已实装 (v0.1)** | `/files` 命令 + `file-viewer` pane |
| [`adapters/codex/`](adapters/codex/) | Codex（Agent Plugins） | 骨架 · `Status: scaffold` | `plugin.json` + `skills/file-viewer/SKILL.md` |
| [`adapters/opencode/`](adapters/opencode/) | OpenCode（plugin） | 骨架 · `Status: scaffold` | `plugin.ts` → 占位 tool `open_file_viewer` |
| [`adapters/deepseek-harness/`](adapters/deepseek-harness/) | DeepSeek Harness（Cordis） | 骨架 · `Status: scaffold` | `index.ts`（JSDoc 挂点 + 空实现） |

每个骨架的集成路线与出处链接见各自 README。

## 快速开始

### core 测试

```bash
npm test        # = node --test "core/src/**/*.test.ts"，零依赖，Node ≥ 22.18（原生 TS）
```

### Claude Code mod

需要 Claude Code CLI **≥ 2.1.287**（mods 支持；更旧先 `claude update`）：

```bash
node scripts/sync-core.mjs                          # 同步 core → hooks/core（改过 core 才需要）
claude plugin validate ./adapters/claude-code       # 校验插件结构
claude plugin test ./adapters/claude-code           # 插件单测（claude-code/testing）
claude --plugin-dir ./adapters/claude-code          # 以本地插件启动
```

会话内输入 `/files`（或 `/files path[:line]`）打开查看器。mod 行为规格见 [ARCHITECTURE.md](ARCHITECTURE.md) §5。

### 其余三个 harness

骨架阶段没有可运行产物，安装/接入方式见各适配层 README（codex：marketplace；opencode：`.opencode/plugins/` + `bun add -d @opencode-ai/plugin`；dsh：等扩展点定稿）。

## 键位

pane 聚焦时生效（打开即聚焦；`Esc` 归还焦点并关闭，`Ctrl+X` `Tab` 重新聚焦）：

| 键 | 作用 |
| --- | --- |
| `f` | 模糊找文件（切到 `Input`，回车选最优匹配） |
| `v` | 循环切换视图：diff → full diff → code/markdown |
| `n` / `p` | 下一个 / 上一个变更文件 |
| `b` | 切换 diff baseline：`HEAD` ⇄ `Base`（按仓库持久化） |
| `c` | changed-only 过滤 ⇄ 全部文件（按仓库持久化） |
| `l` | **互换双栏布局**：树/内容左右对调（按仓库持久化） |
| `r` | 立即刷新 git status + 树 |
| `Tab` / `↑` / `↓` | 在控件（工具条按钮、树行）间移动焦点，树窗口跟随 |
| `Enter` | 按下聚焦的控件：展开/折叠目录、选中文件 |
| `PageUp` / `PageDown` / 滚轮 | 指针在树上移动树光标，在内容上滚动文件 |
| `Esc` | 关闭 pane（`closeOnEscape: true`） |

> `hotkey` 只接受单个小写字母或数字（引擎限制），因此变更跳转是 `n`/`p` 而非 herdr 上游的 `]`/`[`。

## 已知限制（上游）

- **pane 停靠侧固定在 transcript 右侧，无法切换到左侧。** `$.ui.open` 只接受 `id/title/focus/closeOnEscape/holdToasts/rows/columns`，渲染事件里的 `e.props.placement` 是只读；官方文档把 pane 定义为 "a sidebar on the right"，窄终端降级为 prompt 上方的 inline 区域。这是上游缺口，见 [anthropics/claude-code#99404](https://github.com/anthropics/claude-code/issues/99404)（请求 `placement`/`frame` 可选，Open 中）。用户侧也无设置可改；`Ctrl+X`+方向键只调整 pane 大小。
  在此之前，"看哪边"用上面的 **`l` 键**做双栏互换。
- 双栏**内容互换**（树⇄内容）不受影响，见 `l` 键。
- `hotkey` 单键限制导致无法复刻上游的 `]`/`[`、`j`/`k` 逐行导航（焦点模型决定）。
- 内容按行开窗，`Code.source`/`Markdown.text` 各有 10,000 字符元素上限（超限截断并标注）。

## 移植来源与许可证

- **移植来源**：`herdr-file-viewer`（Rust / TUI，上游 <https://github.com/smarzban/herdr-file-viewer>）。本仓库做的是**逻辑移植** —— `git` / `tree` / `view_policy` / `fuzzy` / `search` 的算法与语义逐条翻译成 TS 并配套测试；**渲染层不移植**（Claude Code 原生 `Code` / `Markdown` 元素已提供高亮与渲染）。模块映射见 [ARCHITECTURE.md](ARCHITECTURE.md) §2。
- **许可证**：[MIT](LICENSE)，含上游 `herdr-file-viewer` 的移植部分（© Saeed Marzban，MIT）。

## 开发

### sync-core：core 是唯一事实源

- 平台无关逻辑只存在于 `core/`；适配层**引用**、不**改写**，禁止复制一份 core 之后各自修改。
- 改过 `core/src/` 后运行 `node scripts/sync-core.mjs`，把变更同步进 `adapters/claude-code/hooks/core/`（提交两者）。任何改动一律回 `core/` 改。
- `types.ts` / `host.ts` / `git.ts` 的既有导出**不可改签名，只可加**；改动需同步 [ARCHITECTURE.md](ARCHITECTURE.md) §3。

### 贡献

- 模块映射、冻结契约与文件分工见 [ARCHITECTURE.md](ARCHITECTURE.md)；mods API 速查见 [docs/claude-code-mods-api.md](docs/claude-code-mods-api.md)。
- 提交前跑：`npm test` + `node scripts/sync-core.mjs` + `claude plugin validate --strict ./adapters/claude-code` + `claude plugin test ./adapters/claude-code`。
