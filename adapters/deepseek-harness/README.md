# adapters/deepseek-harness — DeepSeek Harness（dsh）插件

**Status: implemented (v0.1)** — 真实 Cordis 插件：注册 3 个只读模型工具
（`file_tree` / `file_diff` / `content_search`）+ `/files` 人类命令，全部复用
`src/core/`（tree / git / search / types / view_policy），无复制逻辑。
宿主进程内无沙箱：`node:fs/promises` + `child_process.execFile('git', …)`，
git 全程携带 `SAFE_GIT_FLAGS` / `SAFE_GIT_ENV`，不走 shell；路径 POSIX 归一。

## 版本锁定与兼容风险

- 运行时锁定 **`@deepseek-ai/dsh@0.2.0-rc.2`**（peer：`@deepseek-ai/cordis ~4.0.4`、
  `@deepseek-ai/dsh-tools 0.2.0-rc.2`）。0.2.x 仍是 developer preview / alpha，
  官方声明可能有 breaking changes。
- 本插件依赖三个契约：`defineTool` 参数/输出 schema（docs/cookbook/adding-a-tool.md）、
  `ctx.commands.register` 定义（docs/subsystems/commands.md）、
  `ctx.sidebarRight` / `dsh-resource://` 地址语法（docs/subsystems/sidebar-right.md）。
  **升级 dsh 后必须重新核对这三处**（含 alpha→正式版）。

## 结构

```
adapters/deepseek-harness/
  src/index.ts        插件入口：name / inject / apply(ctx)，注册工具+命令
  src/tools.ts        3 个工具定义（defineTool）+ build*Text 输出构造
  src/files-command.ts /files 命令（path[:line] 解析、右栏导航、降级文本）
  src/host.ts         Node Host 实现（fs + execFile git，4 MiB 读取上限）
  src/git-bridge.ts   workspace base / porcelain status 共享查询
  src/address.ts      dsh-resource:// 地址语法（fileAddressFor 镜像）
  src/format.ts       纯文本渲染（树行 / diff / path:line 搜索结果）
  src/core/**         仓库 core/ 的同步副本（scripts/sync-core.mjs），不单独改
  tests/*.test.ts     node:test 用例（含 tests/smoke.test.ts 冒烟 5 例）
  package.json        "type":"module"、main=index.js、dsh.bundle.patch
  cordis.patch.yml    bundle 安装层：按包名 dsh-file-viewer 插入
  cordis.yml          dev 层：绝对路径（正斜杠）指向 src/index.ts
  index.ts            旧入口指针，re-export src/index.ts
```

## 工具与命令

| 名称 | 参数 | 输出 | 实现 |
| --- | --- | --- | --- |
| `file_tree` | `path?`、`changed_only?`、`max_rows?`(≤2000)、`max_depth?`、`show_hidden?` | 缩进树 + git 标记 `[M]/[A]/[D]/[?]`、图例、截断说明 | `core/tree.ts` + porcelain status；`node_modules` 永不下钻；可见行 `depth < max_depth` |
| `file_diff` | `path`（必填）、`baseline?: HEAD\|Base`、`base_branch?`、`full_context?` | `# diff <path> vs <baseline>` + unified diff（≤128 KiB，超出截断） | `core/git.ts fileDiff`（untracked → `--no-index`、unborn HEAD → 空树；无 base 分支时降级 HEAD 并在标题如实写 HEAD） |
| `content_search` | `query`（必填）、`path?`、`limit?`(≤500) | `path:line: 文本` 行 + limit 截断说明 | `core/search.ts`（字面、ASCII 忽略大小写；跳过隐藏/node_modules/二进制/超大文件） |
| `/files`（命令） | `path[:line]` | 文件信息（大小/行数/目标行/git 状态/workspace/`dsh-resource://` 地址）；目录 → 有界树 | `core/types.ts parseFileRef` + 右栏导航（见下） |

路径口径：工具的 `path` 相对 **workspace 根**（git 仓内 = 仓库根，否则 = session cwd）；
session cwd 取 `exec.agent.session.header.cwd`（拿不到则回退 `process.cwd()`），两者不同时
经 `../` 前缀把 root 相对路径翻译成 cwd 相对的文件系统访问。

## 能力边界

- **没有 Claude Code 式 pane**：dsh 0.2.0-rc.2 没有 mods/pane API（experimental 的
  `"band"` dock 另议）。`/files` 的“打开”走右栏**内建 `text` tab**（Document Preview），
  地址 `dsh-resource://file/session/<sid>/<rel>`（Windows 绝对回退
  `dsh-resource://file/absolute/C:/x/y.txt`）。
- **`ctx.sidebarRight` 只在浏览器平面**。实测（dsh 0.2.0-rc.2，见下“冒烟实测”）：
  把 `sidebarRight` 写进 `inject` 会让插件
  `pending (waiting for service: sidebarRight)` **永不激活** —— 所以 `inject` 只有
  `['tools','commands']`，`/files` 用可选 `ctx.get('sidebarRight', false)` 解析，
  拿不到就**降级为文件信息文本 + 地址**（README 即此说明），未来 client 侧接线可直接复用。
- 只读：不写文件、不写 git 索引（`GIT_OPTIONAL_LOCKS=0`）；读取 4 MiB 上限；
  diff 捕获 4 MiB 上限；git 超时 30s。
- `file_search`/glob 未提供（dsh 生态由 tool-fs 搜索承担时会重名，保持最小集）。

## 使用

### dev（无需构建，dsh loader 直接吃 `.ts`）

`cordis.yml`（绝对路径 + 正斜杠，Windows 必须）：

```yaml
- insert:
    - id: file-viewer
      name: 'D:/1024/my/plugin-file-viewer/adapters/deepseek-harness/src/index.ts'
```

```bash
npx -y @deepseek-ai/dsh@0.2.0-rc.2 web --patch <abs>/cordis.yml --no-open --port 3199
# 启动日志出现 [file-viewer] loaded 即成功；无需 API key；结束务必 kill 进程树
```

### 安装为 bundle

```bash
npm run build          # esbuild → index.js（external @deepseek-ai/*）
npx -y @deepseek-ai/dsh@0.2.0-rc.2 plugin add <this dir>   # 应用 cordis.patch.yml（按包名插入）
```

`package.json` 关键字段：`"type":"module"`、`"main":"index.js"`、
`"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`。

### 校验 / 测试

```bash
# 零副作用校验（打印生效 profile 配置后退出）
npx -y @deepseek-ai/dsh@0.2.0-rc.2 --profile web --dump-config

# 单测（Node 26 不接受目录参数，必须用 glob；在仓库根执行）
node --test "adapters/deepseek-harness/tests/*.test.ts"     # 34 pass / 0 fail
npm --prefix adapters/deepseek-harness run typecheck        # tsc --noEmit 通过
```

## 冒烟实测（dsh 0.2.0-rc.2，Windows，2026-10-08）

1. `dump-config`（零副作用）：正常打印 `# == @deepseek-ai/dsh-base` 起的完整 profile 配置后退出，exit 0。
2. `web --patch cordis.yml` — 插件加载成功（stdout，随后 `taskkill /T /F` 清进程树，无残留监听）：

   ```text
   [file-viewer] loaded — tools: file_tree, file_diff, content_search; command: /files
   dsh web: http://127.0.0.1:3199/?token=…
   ```

3. **`inject` 含 `sidebarRight` 的对照实验**（同参数启动，stderr）：

   ```text
   dsh: warning: 1 entry did not activate
   file-viewer (file:///D:/1024/my/plugin-file-viewer/adapters/deepseek-harness/src/index.ts):
     pending (waiting for service: sidebarRight)
   ```

   → 结论：服务只在浏览器平面存在，宿主插件必须可选解析并降级（已按此实现）。
4. 单测：`node --test "…/tests/*.test.ts"` → **pass 34 / fail 0**（含 `tests/smoke.test.ts`
   5 个冒烟用例：fake ctx 注册形状、真实 Host 的 file_tree 输出、content_search `path:line`
   行格式、`parseFileRef` 解析、`/files` 降级文本）；`tsc --noEmit` 通过；
   `esbuild` bundle 产物 index.js 33.6 kb。

## 文档对照

- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md> — `defineTool` / `parameters` / `output.schema+render` / effect 注册
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/commands.md> — `CommandDefinition` / `handler → {kind,text}` / `input.hint`
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sidebar-right.md> — `openResource` / `dsh-resource://file/…` 地址语法 / 内建 `text` tab
