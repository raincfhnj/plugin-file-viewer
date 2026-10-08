/**
 * deepseek-harness (`dsh`) adapter scaffold.
 *
 * Status: scaffold — 占位空实现，刻意不 import 任何 dsh / Cordis API：
 * `@deepseek-ai/cordis` 未安装，且 dsh 当前是 0.2.x alpha（官方明示会有
 * compatibility-breaking changes），扩展点定稿后再接线。
 *
 * dsh 是 "everything is a plugin" 的 Cordis 内核。官方插件形状
 * （见 docs/cookbook/extension-cookbook.md）：
 *
 *   export const name = 'file-viewer'
 *   export const inject = ['agents']        // 依赖的 service，由内核先装配
 *   export function apply(ctx: Context) { ... }   // 注册入口，即 scope 挂点
 *
 * 规划中的挂点（均未实装）：
 * - service：`ctx.tools.register(...)` 暴露 open_file_viewer / read_file / file_diff，
 *   内部复用 core/（tree / view_policy / git / search / fuzzy）
 * - scope：  每次注册都走 `ctx.effect(...)`，随插件卸载/热重载自动回收
 * - UI：     experimental mods 通过 "band" 向 input dock 贡献
 *            Box / Text / Button 序列化 UI 树（用 theme tokens 上色）
 * - skills： `.agents/skills` 下的 skill，按需 inject
 *
 * 对照：Claude Code 侧的 pane / Button / hotkey 规格见 ARCHITECTURE.md §5。
 */

export default function fileViewerPlugin(): void {
  // TODO(dsh): 挂 service（ctx.tools.register）/ scope（ctx.effect）/ UI（"band" → input dock）。
}
