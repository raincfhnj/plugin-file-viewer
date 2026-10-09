/**
 * Browser-half pane reactor: turns durable session events into right-sidebar
 * opens (the Claude Code style "auto pane" for this adapter).
 *
 * Why this lives in the browser half (dsh 0.2.0-rc.2 facts):
 * - `ctx.sidebarRight` exists only in the browser plane; a host command/tool
 *   handler can never call `openResource` (verified live: injecting the
 *   service blocks plugin activation; `commands.execute` is a `@Remote` whose
 *   handler runs on the Host).
 * - The official server→client channel is the durable session event bus:
 *   `tool/result` / `command/run` / `command/done` are appended on the Host
 *   and reach the browser through the Session Controller `follow` stream; the
 *   conversation assembler hands every event of an active Session to every
 *   registered Definition's `match(event)` (docs/subsystems/conversation.md;
 *   a Definition without `target`/`buildViewNode` is a pure observer — the
 *   shipped registry's `assertDefinitionTarget` only requires the pair
 *   together).
 * - The target address travels host-computed:
 *     - tools: `output.presentationMeta` → persisted verbatim as
 *       `tool/result.meta.fileViewer` (`{ address?, line?, tab? }`) — the
 *       address is session-scoped because only the Host knows `agent.id`;
 *     - `/files`: the `sidebar address:` line in `command/done`'s text.
 *
 * Replay safety: the assembler also replays history when a Session view opens,
 * so every act is gated on `event.time >= armedAt` (armed at plugin load minus
 * a clock-skew grace). Only events appended after this page booted can open a
 * pane — history hydration stays silent.
 *
 * This module is pure: no cordis, no DOM, no `@deepseek-ai/*` runtime imports —
 * it bundles into the browser factory as-is (see scripts/build-client.mjs).
 * Tests drive it with literal event objects.
 */
import { parseFileRef } from './core/types.ts';

/** The human command whose successful run opens the requested target. */
const PANE_COMMAND = 'files';

/** Bounded pending map (a page lives long; cancelled calls would leak). */
const PENDING_CAP = 128;

/** Session-scoped addresses only: the builtin `text` tab claims those alone. */
const SESSION_ADDRESS_PREFIX = 'dsh-resource://file/session/';

/** First line of `/files` success text for a file (files-command fileInfoLines). */
const FILE_INFO_MARK = ' — file';

/** First line of `/files` success text for a directory (tools buildFileTreeText). */
const TREE_TITLE_MARK = '# file tree';

const SIDEBAR_ADDRESS_LINE = /^sidebar address: (\S+)$/m;

/** Tool-result presentation payload produced by `output.presentationMeta`. */
export interface PaneFileViewerMeta {
  address?: string;
  line?: number;
  tab?: string;
}

export interface PaneReactorDeps {
  /** Clock override for tests (default `Date.now`). */
  now?: () => number;
  /** Open a session-scoped `dsh-resource://` file address in the builtin text tab. */
  openFile: (address: string, line?: number) => void;
  /** Open the workspace file-tree tab (`files` kind). */
  openFilesTab: () => void;
  /** Diagnostic sink (console in the browser). */
  log?: (message: string) => void;
  /** Clock-skew grace before `armedAt` (default 10 000 ms). */
  graceMs?: number;
}

/** Structural view of a Session event envelope (real type is a subtype). */
export interface PaneEventLike {
  type?: unknown;
  time?: unknown;
  data?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Insert with a hard cap, evicting the oldest key (Map preserves order). */
function cappedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > PENDING_CAP) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export interface PaneReactor {
  /** Deliver one session event; never throws. */
  handle(event: PaneEventLike): void;
}

/**
 * Build the reactor. One instance per plugin fiber; `armedAt` is fixed at
 * construction (page boot) so history replay can never open a pane.
 */
export function createPaneReactor(deps: PaneReactorDeps): PaneReactor {
  const now = deps.now ?? Date.now;
  const grace = deps.graceMs ?? 10_000;
  const armedAt = now() - grace;
  const pendingCommands = new Map<string, string>();

  /** Live means appended after this page booted (within skew grace). */
  const live = (event: PaneEventLike): boolean =>
    typeof event.time === 'number' && event.time >= armedAt;

  const log = (message: string): void => {
    deps.log?.(`[file-viewer] ${message}`);
  };

  /** Open a file address; session-scope only, failures contained. */
  const openAddress = (address: string, line?: number): void => {
    if (!address.startsWith(SESSION_ADDRESS_PREFIX)) {
      log(`skip open: outside the workspace, no pane for ${address}`);
      return;
    }
    try {
      deps.openFile(address, line);
    } catch (error) {
      log(`openResource failed for ${address}: ${String(error)}`);
    }
  };

  const openTree = (): void => {
    try {
      deps.openFilesTab();
    } catch (error) {
      log(`openTab('files') failed: ${String(error)}`);
    }
  };

  /** `tool/result` → `meta.fileViewer` projection (host: presentationMeta). */
  const onToolResult = (data: Record<string, unknown>): void => {
    const message = asRecord(data.message);
    if (data.error !== undefined || message.isError === true) return;
    const viewer = asRecord(asRecord(data.meta).fileViewer);
    const tab = asString(viewer.tab);
    if (tab === 'files') {
      openTree();
      return;
    }
    const address = asString(viewer.address);
    if (!address) return;
    openAddress(address, asLine(viewer.line));
  };

  const onCommandRun = (data: Record<string, unknown>): void => {
    if (data.name !== PANE_COMMAND) return;
    const commandId = asString(data.commandId);
    if (!commandId) return;
    cappedSet(pendingCommands, commandId, typeof data.args === 'string' ? data.args : '');
  };

  const onCommandDone = (data: Record<string, unknown>): void => {
    const commandId = asString(data.commandId);
    if (!commandId) return;
    const rawInput = pendingCommands.get(commandId);
    pendingCommands.delete(commandId);
    if (rawInput === undefined || data.kind !== 'success') return;
    const text = typeof data.text === 'string' ? data.text : '';
    if (!text) return;
    const addressMatch = SIDEBAR_ADDRESS_LINE.exec(text);
    if (!addressMatch) return;
    const address = addressMatch[1]!;

    const newline = text.indexOf('\n');
    const firstLine = newline === -1 ? text : text.slice(0, newline);
    if (firstLine.includes(FILE_INFO_MARK)) {
      let line: number | undefined;
      try {
        line = parseFileRef(rawInput.trim()).line;
      } catch {
        line = undefined;
      }
      openAddress(address, line);
      return;
    }
    if (firstLine.startsWith(TREE_TITLE_MARK)) {
      openTree();
    }
    // Deleted/missing targets keep their info text; nothing opens.
  };

  return {
    handle(event: PaneEventLike): void {
      try {
        if (event === null || typeof event !== 'object') return;
        const type = event.type;
        if (typeof type !== 'string') return;
        const data = asRecord(event.data);
        if (type === 'tool/result') {
          if (live(event)) onToolResult(data);
        } else if (type === 'command/run') {
          onCommandRun(data);
        } else if (type === 'command/done') {
          if (live(event)) onCommandDone(data);
        }
      } catch (error) {
        // A throwing observer would break the conversation dispatcher.
        log(`event handling failed: ${String(error)}`);
      }
    },
  };
}
