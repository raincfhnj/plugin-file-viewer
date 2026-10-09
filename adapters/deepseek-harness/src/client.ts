/**
 * Browser half (`dsh.client` face) of the file-viewer plugin — the piece that
 * makes the right-sidebar pane open automatically (Claude Code style).
 *
 * Wiring (dsh 0.2.0-rc.2):
 * - This module is served through the client-modules boot graph: the package
 *   declares `dsh.client` + `exports["./client"]` in package.json, so the Host
 *   loader entry that mounts the tools/commands face also mounts this face in
 *   the page (docs/subsystems/client-modules.md). The bundle format is the
 *   `window.__ModuleLoader__.load({ id, factory })` wrapper — built by
 *   scripts/build-client.mjs (byte-pattern verified against the shipped
 *   `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`).
 * - `apply` observes the durable session event stream through the official
 *   client extension point `ctx.uiConversation.events.register(definition)`
 *   (docs/subsystems/conversation.md): the shipped registry's
 *   `assertDefinitionTarget` only rejects a Definition whose `target` /
 *   `buildViewNode` are not both present, so `{ kind, match }` is a pure
 *   observer — `match(event)` runs for every event of an active Session and
 *   renders nothing.
 * - On a live `tool/result` it reads the host-computed
 *   `meta.fileViewer { address?, line?, tab? }` (produced by the tools'
 *   `output.presentationMeta`); on `command/run` + `command/done` it parses
 *   the `sidebar address:` line of `/files` text. It then calls
 *   `ctx.sidebarRight.openResource(address, { params })` or `openTab('files')`
 *   (docs/subsystems/sidebar-right.md).
 *
 * Types are structural on purpose: the browser packages are not devDependencies
 * of this adapter, and the real service shapes satisfy these views.
 */
import { createPaneReactor, type PaneEventLike } from './client-pane.ts';

export const name = 'file-viewer';

/** Browser-plane services this half waits for (both ship in the web profile). */
export const inject = ['sidebarRight', 'uiConversation'];

/** Minimal structural view of the client context (real: cordis Context). */
export interface ClientContext {
  effect(fn: () => unknown, label?: string): unknown;
  sidebarRight: {
    openResource(address: string, options?: { params?: { line?: number } }): unknown;
    openTab(kind: string, options?: unknown): unknown;
  };
  uiConversation: {
    events: {
      register(definition: {
        kind: string;
        match: (event: PaneEventLike) => { id: string; role: string } | null;
      }): () => void;
    };
  };
}

export function apply(ctx: ClientContext): void {
  const reactor = createPaneReactor({
    openFile: (address, line) => {
      if (line === undefined) ctx.sidebarRight.openResource(address);
      else ctx.sidebarRight.openResource(address, { params: { line } });
    },
    openFilesTab: () => {
      ctx.sidebarRight.openTab('files');
    },
    log: (message) => {
      console.log(message);
    },
  });

  ctx.effect(
    () =>
      ctx.uiConversation.events.register({
        kind: 'file-viewer:pane',
        // Pure observer: side-effect into the reactor, never claim a node.
        match: (event) => {
          reactor.handle(event);
          return null;
        },
      }),
    'file-viewer: pane observer',
  );

  // Smoke marker: proves this face activated inside the page (README § 冒烟).
  (globalThis as { __fileViewerPane?: string }).__fileViewerPane = 'ready';
  console.log('[file-viewer] client half mounted — right-sidebar auto-open armed');
}
