/**
 * DeepSeek Harness (dsh) plugin — git-aware read-only file viewer.
 *
 * Shape (docs/user/develop/basic/index.md): a function module exporting
 * `name` / `inject` / `apply(ctx)`. Registered through `ctx.tools` and
 * `ctx.commands`; both registrations are effect-based and are recycled when
 * the plugin fiber unloads.
 *
 * Mount (dev, no build step — Node ≥ 22.18 native type stripping):
 *   dsh web --patch <abs>/cordis.yml --no-open
 * Mount (installed bundle): `dsh plugin add <this dir>` → cordis.patch.yml
 * inserts the `dsh-file-viewer` package by name.
 *
 * Injected seams: `tools` (model tools) and `commands` (`/files`).
 * `sidebarRight` is deliberately NOT injected — it is a browser-plane service
 * (see src/files-command.ts and README.md).
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-commands';
import { createNodeHost } from './host.ts';
import {
  createContentSearchTool,
  createFileDiffTool,
  createFileTreeTool,
  type ToolDeps,
} from './tools.ts';
import { createFilesCommand, type SidebarNavigator } from './files-command.ts';

export const name = 'file-viewer';

/**
 * `sidebarRight` is NOT injected: verified live on dsh 0.2.0-rc.2 — injecting it
 * makes the entry `pending (waiting for service: sidebarRight)` and the plugin
 * never activates (the service is provided by the browser client plane only).
 * `/files` resolves it optionally via `ctx.get('sidebarRight', false)` and
 * degrades to file info + the `dsh-resource://` address when absent.
 */
export const inject = ['tools', 'commands'];

export function apply(ctx: Context): void {
  const host = createNodeHost();
  const deps: ToolDeps = { host, processCwd: () => process.cwd() };
  const log = (message: string): void => {
    console.log(message);
  };

  // Right-sidebar navigator: provided only by the browser half in dsh
  // 0.2.0-rc.2, so this resolves to undefined on the host and `/files`
  // degrades to file info + the dsh-resource address.
  const getSidebarRight = (): SidebarNavigator | undefined => {
    try {
      const service = ctx.get('sidebarRight', false) as SidebarNavigator | undefined;
      return service && typeof service.openResource === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  };

  ctx.effect(() => ctx.tools.register(createFileTreeTool(deps)), 'file-viewer: file_tree');
  ctx.effect(() => ctx.tools.register(createFileDiffTool(deps)), 'file-viewer: file_diff');
  ctx.effect(
    () => ctx.tools.register(createContentSearchTool(deps)),
    'file-viewer: content_search',
  );
  ctx.effect(
    () => ctx.commands.register(createFilesCommand({ ...deps, getSidebarRight, log })),
    'file-viewer: /files',
  );

  log('[file-viewer] loaded — tools: file_tree, file_diff, content_search; command: /files');
}
