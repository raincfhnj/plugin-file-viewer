# ARCHITECTURE — plugin-file-viewer

跨 harness 文件查看器：从 [herdr-file-viewer](D:\1024\my\study\herdr-file-viewer)（Rust/TUI）移植核心逻辑，
先实装 **Claude Code mod**，为 **Codex / OpenCode / DeepSeek Harness** 预留适配层。

## 1. 分层

```
core/                      平台无关 TS（零依赖，纯逻辑 + Host I/O 接口）
  src/types.ts             契约类型（冻结，改动需同步本文档）★我方维护
  src/host.ts              Host 接口（冻结）★我方维护
  src/git.ts               git 只读服务（契约已写，补充测试）★A
  src/tree.ts              文件树 + 展开态 + git 标记           ★A
  src/view_policy.ts       视图决策（diff/rendered/syntax）     ★B
  src/fuzzy.ts             模糊匹配                             ★B
  src/search.ts            内容搜索 (path:line)                 ★B
adapters/
  claude-code/             Claude Code mod（本次实装）★C
  codex/                   预留骨架                             ★D
  opencode/                预留骨架                             ★D
  deepseek-harness/        预留骨架                             ★D
docs/claude-code-mods-api.md   mods API 速查（★C 主要依据）
README.md                  ★D
```

## 2. Rust → TS 映射（移植参考源）

| TS 模块 | 参考文件（D:\1024\my\study\herdr-file-viewer\src） | 移植要点 |
|---|---|---|
| git.ts | git.rs | porcelain -z 解析、只读命令、安全 flag、untracked diff、base 分支探测。**不移植**：worktree、多 baseline UI |
| tree.rs → tree.ts | tree.rs | 目录优先+字母序 cmp、展开集、changed-only 合成树、dir_dirty、锚点选择。**不移植**：compact_dirs 折叠（v0.2）、鼠标 |
| view_policy.ts | view_policy.rs | `default_mode` / `applicable_modes` 逐条语义 + 其测试用例全部翻译成 TS 测试 |
| fuzzy.ts | fuzzy.rs | 打分算法逐条移植 |
| search.ts | search.rs / project_search.rs | 逐行扫描 + 摘要；v0.1 可简化（不进 .gitignore 外的 node_modules 即可） |
| — | presenter.rs / highlight.rs / render.rs | **不移植**：Claude Code 原生 `Code`/`Markdown` 元素已提供高亮/渲染 |

## 3. 核心契约（签名冻结）

```ts
// types.ts
type GitStatus = 'Modified' | 'Added' | 'Deleted' | 'Untracked';
type Baseline  = 'HEAD' | 'Base';
type NodeKind  = 'dir' | 'file';
type ViewMode  = 'renderedMarkdown' | 'diff' | 'fullDiff' | 'syntaxContent';
type ChangedFileView = 'diff' | 'content';
interface TreeNode { path; kind; depth; expanded; status?; dirDirty; label? }
interface FileDescriptor { path; isMarkdown; isChanged; isDeleted }
interface Host { cwd(); isWindows; listDir(rel); readText(rel); exists(rel); runGit(absDir, args) }

// git.ts（已实现）
parsePorcelainStatus(out: string): Map<string, GitStatus>
status(host, repoRoot): Promise<Map<string, GitStatus>>
fileDiff(host, repoRoot, relPath, baseline, opts?): Promise<string>

// tree.ts（★A 实现，签名冻结）
interface TreeOptions { changedOnly: boolean; hideHidden: boolean }
interface TreeState { root: string; expanded: Set<string>; selected?: { path: string; kind: NodeKind } }
createTreeState(root: string): TreeState
listRows(host, state, statusMap, opts): Promise<TreeNode[]>   // 按展开态产出可见行
toggle(state, path): TreeState                                 // 展开/折叠目录（文件不变）
select(path: string, kind: NodeKind): TreeState                // 返回新 state（不可变风格）
nextChanged(rows: TreeNode[], currentPath: string | undefined, dir: 1 | -1): string | undefined

// view_policy.ts（★B 实现，签名冻结）
isMarkdownPath(path: string): boolean
defaultMode(fd: FileDescriptor, pref: ChangedFileView): ViewMode
applicableModes(fd: FileDescriptor, pref: ChangedFileView): ViewMode[]

// fuzzy.ts（★B 实现，签名冻结）
fuzzyScore(pattern: string, target: string): number | undefined   // undefined=不匹配
fuzzyFilter<T>(pattern: string, items: readonly T[], key: (t: T) => string): Array<{ item: T; score: number }>

// search.ts（★B 实现）
interface SearchMatch { path: string; line: number; text: string }
searchContent(host, root, query, opts?: { limit?: number }): Promise<SearchMatch[]>
```

## 4. 规则（所有 agent 遵守）

1. **只写自己的文件**（见 §1 星标）；`types.ts` / `host.ts` / `git.ts` 的既有导出不可改签名，只可加。
2. **core 零依赖**：禁止 import node:* / npm 包；I/O 只经 `Host`。
3. **TS 必须 erasable-only**：禁止 enum/namespace/参数属性；相对导入带 `.ts` 扩展名（Node 26 原生运行）。
4. 每个模块配 `*.test.ts`（`node --test core/` 运行，零配置）；view_policy 必须覆盖参考仓库 view_policy.rs 的全部测试语义。
5. 禁止写注释以外的文档膨胀；JSDoc 只写在导出面上。
6. Windows 环境：路径在 core 内一律 POSIX 相对路径；宿主绝对路径由适配层转换。

## 5. Claude Code mod 行为规格（★C）

- 命令 `/files [path[:line]]`：打开 pane `id:'file-viewer'`, `title:'Files'`, `focus:true`, `closeOnEscape:true`；带 path 则选中该文件，带 line 则内容窗定位到该行附近。
- 布局：`Box(flexDirection:'row')` = 左树（约 30% 宽，`borderStyle:'single'`）+ 右内容。
- 树行：可见窗口内每行一个 `Button`（label = 状态记号 `M/A/D/?` + 缩进 + 名称，`dirDirty` 目录加记号），onPress 选中；焦点移动超出窗口时自管滚动（参考 diff mod 的 `ui.scroll` 接管模式）。
- 内容区按 `defaultMode`/`applicableModes`：
  - `diff` → `Code({ format:'diff', source, path })`
  - `syntaxContent` → `Code({ source, path })`（元素自动推断语言，`startLine` 支持行号）
  - `renderedMarkdown` → `Markdown({ text })`
  - 截断：`Code.source`/`Markdown.text` ≤10000 字符，超限尾部加 `… [truncated]`
- 工具条（Button + hotkey）：`f` 模糊找文件（切到 `Input`）、`v` 循环视图、`]`/`[` 下一个/上一个变更、`b` 切换 baseline(HEAD/Base)、`c` changed-only 过滤、`r` 刷新。
- 数据流：模块级 `model` + 去抖 `redraw()`（`$.clock.after` 合并 → `$.ui.invalidate('ui.render')`）；`ui.render{Pane}` 每次从 model 重建树（单向数据流，参考 diff mod）。
- 刷新时机：`session.start`（初载）、`command.run{files}`（先 refresh 再 open）、`tool.call` Edit/Write/Bash 后 `await next(e)` 再 scheduleRefresh。
- Host 实现：`$.fs.list/read/exists`、`$.process.run(['git', ...SAFE_GIT_FLAGS, ...args], ...)`（注意：`$.process.run` 单独签名，适配层负责包 SAFE flags）。
- 状态：会话态用模块级变量；跨 reload/会话的偏好（baseline、changedOnly）进 `$.store`。
- 大小写/Windows：`$.session.cwd()` 为绝对路径，core 相对路径 POSIX 化。
- 测试：`claude plugin validate`、`claude plugin test`（`claude-code/testing`）；本机 CLI=2.1.284，mods 需 ≥2.1.287，若无 `--plugin-dir` 支持先 `claude update`。

## 6. 预留适配层最小要求（★D）

每个骨架目录含 `README.md`（该 harness 的集成路线 + 出处链接）+ 可编译的占位入口：
- codex/: `plugin.json`（agent-plugins schema）+ `skills/file-viewer/SKILL.md`
- opencode/: `plugin.ts`（导出 `Plugin`，注册占位 tool `open_file_viewer`）
- deepseek-harness/: `index.ts`（Cordis 插件占位 + `dsh-plugin` topic 说明）
