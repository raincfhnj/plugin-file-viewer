# Claude Code mods API 速查（v2.1.287+，依据官方文档 + mods/diff 源码）

出处：code.claude.com/docs/en/plugins/mods/{overview,interface,reference,api,events,create}；
github.com/anthropics/claude-code/tree/main/mods/diff；mods/types/claude-code.d.ts。

## 文件结构（本仓库 adapters/claude-code/）

```
.claude-plugin/plugin.json   {"name","version","description"}（mod 无需额外字段）
hooks/hooks.json             {"description":"...", "modules": ["./register.ts"]}
hooks/register.ts            入口：export function register(on, options)
hooks/…                      可分件；只允许相对路径 import；禁动态 import；唯一裸导入 'claude-code'
```

静态校验（`claude plugin validate`）：`$.fs.read(...)` 等调用必须字面完整；`on('事件')` 必须字符串字面量；
register 内不得再声明 `on`；不得把 `$` 或其命名空间赋值/解构给变量。

## hooks 运行时约束

- **无 Node API**：无 setTimeout/无 node:fs/无网络直连；只有 `$.` + 标准 web API（URL/TextEncoder/AbortController/crypto.subtle）。
- hook 10s 超时（超时被跳过）；`.catch(handler)` 错误兜底（1s）。
- 模块顶层 `let` = 会话态（reload 重置）；`$.state`（atom）= 跨 reload；`$.store` = 跨会话 JSON（≤4MiB）。
- 崩 3 次 → 所有非内置 mod 被卸载（`/reload-plugins` 恢复）。

## 事件

```ts
export function register(on, options) {
  on('session.start', async ($, e, next) => { …; return next(e) })
}
```
hook 签名 `async ($, e, next)`；`e` 深冻结，改则 `next({...e, 字段})`；不调 next 直接 return 对象 = 自己应答。

| 事件 | matcher | 用途 |
|---|---|---|
| `session.start` | — | 首个 prompt 前 + 每次 reload；注册 `$.command.register`、初载数据 |
| `command.run` | `{command:'files'}` | `/files` 被输入；`e.args`；返回 `{}`=不打印 / `{text}`=打印给模型 |
| `ui.render` | `{component:'Pane'}` | 画 pane；`e.requestId`=pane id；返回元素树 |
| `tool.call` | `{tool:['Edit','Write',…]}` | `await next(e)` 得结果后触发刷新 |
| `ui.press` / `ui.input` / `ui.select` | — | 控件回调（Button.onPress 等） |
| `ui.focus` | — | 焦点环移动前（`e.element`），可改落点 |
| `ui.scroll` | `{requestId: PANE}` | 自管滚动：`e.offset/bodyRows/contentRows`，返回 `{}` 表示自己滚 |
| `ui.close` | `{id}` | 关闭前；不调 next 可拦截（origin 非 unload） |

## 画 pane

```ts
await $.ui.open({ id: 'file-viewer', title: 'Files', focus: true,
                  closeOnEscape: true, rows: 24, columns: 100 })
await $.ui.close({ id: 'file-viewer' })
await $.ui.panes()   // [{id,title,isShown,isFocused,isPlaced}]
```
- `focus` 仅在 prompt 空且无其它焦点时生效；三态标志只接受 true/省略。
- 用户行为（命令/按钮）开 pane 无宽度门槛；mod 自主开需 ≥144 列。
- `$.ui.open` 可能返回 `{isPlaced:false}`（等宽度）→ 应 `$.ui.close` 撤回（diff mod 模式）。
- 重绘：`$.ui.invalidate('ui.render')`（可见 pane 30 次/秒节流）；`$.clock.after(ms, fn)` 去抖。
- 局部刷新 `$.ui.blit`（Raster，v0.1 不用）。

### ui.render hook

```ts
on('ui.render', { component: 'Pane' }, async ($, e, next) => {
  if (e.requestId !== 'file-viewer') return next(e)
  const { Box, Text, Button, Input, Select, Code, Markdown, Link } = $.ui.resolve(e)
  // e.props: { title, isFocused, bodyColumns, placement:'dock'|'inline', scroll:{offset,bodyRows} }
  return Box({ flexDirection:'row', children:[ … ] })
})
```
校验失败 = 整棵树不画（transcript 出现 `ui.render (Pane) refused: <原因>`）。

### 元素（props 全部对象参数；终端 surface）

| 元素 | 关键 props | 限制 |
|---|---|---|
| `Box` | flexDirection, width/height/flexGrow, gap, padding*, borderStyle(`single|double|round|bold|dashed|…`), borderColor, backgroundColor, overflow, children | — |
| `Text` | children, color, backgroundColor, bold/italic/underline, dimColor, inverse, wrap(`truncate-*`…) | — |
| `Button` | key, label, onPress(), hotkey(**单个数字或小写字母**), plain, dimColor, autoFocus:true | 同键后画者胜 |
| `Input` | key(必), label, placeholder, value, onSubmit(v,e), onInput(v,e), autoFocus | — |
| `Select` | key, options, value, onSelect(v,e) | — |
| `Code` | **source ≤10000 字符**, language, path(推断语言), startLine(行号槽), format:'source'\|'diff', wrap | 原生语法高亮/diff 着色 |
| `Markdown` | **text ≤10000 字符**, key(有 onLinkPress 时必), onLinkPress | 原生渲染 |
| `Link` | href, label | — |
| `Raster`/`Image` | 像素级 | 仅终端；v0.1 不用 |
| `Client` | module:'./x.tsx'(字面量), post(data)；surface 模块有 `onKey/onPointer` | **唯一原始按键通道**；需点击拿焦点；v0.1 不用 |

## 键盘（mod 永远不直接读键）

- 归属：按键 → Claude Code 判定 → 聚焦控件的回调。pane 须持焦点（open focus:true / Ctrl+X Tab / 点击）。
- Tab=下一控件；↑/↓=焦点移动（画不下→滚动整 pane）；Enter=按下；hotkey=直触按钮；
  PageUp/Down/Home/End=滚动；Ctrl+X+方向键=调大小；Ctrl+X+X=关；Esc=还焦点（closeOnEscape 同时关）。
- **无法** jk 逐行导航（hotkey 单键单按钮）；行导航用 Button+焦点窗口（diff mod 模式）。

## 读文件 / 跑命令

```ts
await $.fs.read(path)            // ≤4MiB；相对 cwd
await $.fs.list(dir)             // 一层：{name,kind,size,isLink}
await $.fs.exists(path); await $.fs.stat(path)
await $.process.run(['git','status','--porcelain'], { /* 无 shell, argv 数组 */ })
// → {exitCode, stdout, stderr}；30s 超时；起不来/超时 reject → try/catch
await $.process.spawn(cmd, args, { onOutput })
$.session.cwd() / .root() / .id()
$.store.get/set/delete/keys
$.clock.after(ms, fn) / $.clock.every(ms, fn)
$.command.register({ name, description, argumentHint, immediate })
$.ui.invalidate('ui.render'); $.ui.log(text, {to:'debug'})
```

## /files 命令模式

```ts
// session.start 内（重名 throw → 放 hook 末尾或 try/catch）
await $.command.register({ name: 'files', description: 'Open file viewer', argumentHint: '[path[:line]]', immediate: true })
on('command.run', { command: 'files' }, async ($, e) => {
  // refresh 数据 → await $.ui.open({...}) → isPlaced===false 时 $.ui.close 撤回
  return {}    // {} 不打印
})
```

## 内置 diff mod 关键模式（借鉴）

1. 单向数据流：模块级 `model` + `redraw()`（clock.after 去抖 → invalidate）；render 从 model 重建树。
2. open 前先取数（避免 Loading 闪现）；`isPlaced===false` 立即 close 撤回。
3. 树只画"窗口内"行（bodyRows），焦点移动自管滚动（`ui.scroll` 返回 `{}` 接管）。
4. `tool.call{Edit,Write,Bash}`：`await next(e)` 后 `scheduleRefresh`（串行化 isRefreshing + 去抖）。
5. 偏好进 `$.store`，会话态留模块变量；宿主 `$.` 包一层便于测试。

## 测试 / 调试

```bash
claude --plugin-dir ./adapters/claude-code     # 加载+热重载
claude plugin validate ./adapters/claude-code  # 静态检查（--strict --json）
claude plugin test                             # 跑 **/*.test.ts，无需登录
claude --debug --debug-file ./debug.log --plugin-dir ./adapters/claude-code
/reload-plugins                                # 会话内重载
```
测试：`import { expect, test } from 'claude-code/testing'`；`test('name', async ($, on) => { on(...stub) })`。
类型：--plugin-dir 加载时写 `.claude-plugin/types/`（claude-code/index.d.ts 最权威）。

## 限制备忘

- 本机 CLI 2.1.284 < 2.1.287（mods 终端默认启用线）→ 先 `claude update`；早期可用 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`。
- 权限提示不可改；Surface 差异（desktop/vscode 不同）；`claude -p`/`--safe-mode`/`--bare` 不加载 mod。
- 树文本 100,000 字符上限；`$.session.messages()` 4096 条。
