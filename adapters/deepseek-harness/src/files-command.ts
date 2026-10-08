/**
 * The `/files` human command: parse `path[:line]`, show file/tree info, and —
 * when a right-sidebar navigator is available — open the builtin text viewer.
 *
 * dsh 0.2.0-rc.2 fact (verified against the shipped packages): `ctx.sidebarRight`
 * is provided only by the browser half of `@deepseek-ai/dsh-client-ui-sidebar-right`
 * (its host half is an empty `apply()`), so a host-side command handler cannot
 * call `openResource`. `getSidebarRight` therefore stays optional: the handler
 * tries it when present (future/client-plane wiring) and otherwise degrades to
 * file info plus the `dsh-resource://` address — documented in the README.
 *
 * Types here are structural on purpose: the command registry's real
 * `CommandInvocation` / `CommandResult` satisfy them, so this module carries no
 * hard dependency on `@deepseek-ai/dsh-commands` and stays trivially testable.
 */
import type { Host } from './core/types.ts';
import { parseFileRef } from './core/types.ts';
import { gitStatusOf, workspaceBaseFor } from './git-bridge.ts';
import { buildFileTreeText } from './tools.ts';
import { fileAddressFor, isAbsolutePath, relativeToWorkspace, toPosixPath } from './address.ts';
import { statusMarker } from './format.ts';

/** Right-sidebar navigation surface (browser plane), structurally typed. */
export interface SidebarNavigator {
  openResource(address: string, options?: { params?: { line?: number } }): unknown;
}

export interface FilesCommandDeps {
  host: Host;
  /** Fallback working directory when the invocation carries no session cwd. */
  processCwd: () => string;
  /** Resolves the right-sidebar service; undefined on the host plane. */
  getSidebarRight?: () => SidebarNavigator | undefined;
  log?: (message: string) => void;
}

/** Minimal structural view of `CommandInvocation` (real type is a subtype). */
export interface FilesInvocation {
  rawInput: string;
  agent?: {
    id?: string;
    session?: { header?: { cwd?: string } };
  };
}

/** Minimal structural view of `CommandResult`. */
export type FilesResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string };

const USAGE =
  'usage: /files <path[:line]> — show file info; opens the right-sidebar text viewer when the ' +
  'client plane is available. Example: /files src/index.ts:42';

const HOST_PLANE_NOTE =
  'note: opening the right sidebar needs the client-plane ctx.sidebarRight, which dsh 0.2.0-rc.2 ' +
  'does not expose to host command handlers (see adapters/deepseek-harness/README.md); the ' +
  'address above is what a client-side navigator would open.';

const STATUS_STALE =
  'git: path changed in the working tree but no longer exists on disk (deleted)';

function posixJoin(base: string, rel: string): string {
  const left = toPosixPath(base).replace(/\/+$/, '');
  const right = rel.replace(/^\/+/, '');
  return right.length > 0 ? `${left}/${right}` : left;
}

/** Classify an absolute path as a file, directory, or missing entry. */
async function classifyPath(host: Host, abs: string): Promise<'file' | 'dir' | 'missing'> {
  if (!(await host.exists(abs))) return 'missing';
  const slash = abs.lastIndexOf('/');
  const parent = slash <= 0 ? '' : abs.slice(0, slash);
  const name = abs.slice(slash + 1);
  try {
    const entry = (await host.listDir(parent)).find((e) => e.name === name);
    if (entry) return entry.kind;
  } catch {
    // fall through to the read probe below
  }
  try {
    await host.readText(abs);
    return 'file';
  } catch {
    return 'dir';
  }
}

function fileInfoLines(
  displayPath: string,
  ref: { line?: number },
  facts: {
    size?: number;
    lineCount?: number;
    targetLine?: string;
    statusText?: string;
    address?: string;
    workspace: string;
  },
): string[] {
  const lines: string[] = [];
  const sizeText = facts.size === undefined ? '' : `, ${facts.size} bytes`;
  const countText = facts.lineCount === undefined ? '' : `, ${facts.lineCount} lines`;
  lines.push(`${displayPath} — file${sizeText}${countText}`);
  if (ref.line !== undefined && facts.targetLine !== undefined) {
    const trimmed = facts.targetLine.length > 400 ? `${facts.targetLine.slice(0, 400)}…` : facts.targetLine;
    lines.push(`at ${ref.line}: ${trimmed}`);
  }
  if (facts.statusText) lines.push(`git: ${facts.statusText}`);
  lines.push(`workspace: ${facts.workspace}`);
  if (facts.address) lines.push(`sidebar address: ${facts.address}`);
  return lines;
}

/** The command handler — pure of cordis, driven by `FilesCommandDeps`. */
export function createFilesCommandHandler(
  deps: FilesCommandDeps,
): (invocation: FilesInvocation) => Promise<FilesResult> {
  return async function filesHandler(invocation: FilesInvocation): Promise<FilesResult> {
    const input = (invocation.rawInput ?? '').trim();
    if (!input) return { kind: 'error', text: USAGE };
    const ref = parseFileRef(input);
    if (!ref.path) return { kind: 'error', text: USAGE };

    const cwd = toPosixPath(invocation.agent?.session?.header?.cwd || deps.processCwd());
    const { base, gitRoot } = await workspaceBaseFor(deps.host, cwd);
    const sessionId = invocation.agent?.id;
    const statusMap = await gitStatusOf(deps.host, gitRoot ?? base);

    // Resolve to an absolute path: absolute input wins; otherwise try the
    // session cwd first (what the user sees in a shell), then the workspace base.
    const norm = ref.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const candidates = isAbsolutePath(norm)
      ? [toPosixPath(norm)]
      : [...new Set([posixJoin(cwd, norm), base === cwd ? '' : posixJoin(base, norm)])].filter(
          (c) => c.length > 0,
        );

    let absPath: string | undefined;
    for (const candidate of candidates) {
      if (await deps.host.exists(candidate)) {
        absPath = candidate;
        break;
      }
    }

    // Missing on disk: a git-deleted path still deserves an answer.
    if (!absPath) {
      const first = candidates[0] ?? norm;
      const baseRel = relativeToWorkspace(base, first) ?? first;
      const deleted = statusMap.get(baseRel) === 'Deleted';
      if (!deleted) {
        return {
          kind: 'error',
          text: `not found: ${input} (workspace: ${base}; cwd: ${cwd})`,
        };
      }
      const address = fileAddressFor(sessionId, cwd, first);
      return {
        kind: 'success',
        text: [
          `${baseRel} — deleted in the working tree`,
          STATUS_STALE,
          `workspace: ${base}`,
          `sidebar address: ${address}`,
          HOST_PLANE_NOTE,
        ].join('\n'),
      };
    }

    const baseRel = relativeToWorkspace(base, absPath);
    const display = baseRel ?? absPath;
    const kind = await classifyPath(deps.host, absPath);
    const address = fileAddressFor(sessionId, cwd, absPath);
    const status = baseRel !== undefined ? statusMap.get(baseRel) : undefined;
    const statusText = status ? `[${statusMarker(status)}] ${status}` : undefined;

    // Best-effort right-sidebar open (client plane only — see module doc).
    let opened = false;
    if (kind === 'file') {
      try {
        const sidebar = deps.getSidebarRight?.();
        if (sidebar) {
          sidebar.openResource(
            address,
            ref.line !== undefined ? { params: { line: ref.line } } : undefined,
          );
          opened = true;
          deps.log?.(`[file-viewer] opened ${address}${ref.line ? ` (line ${ref.line})` : ''}`);
        }
      } catch (error) {
        deps.log?.(`[file-viewer] sidebarRight.openResource failed: ${String(error)}`);
      }
    }
    if (opened) {
      return {
        kind: 'success',
        text: `Opened ${display}${ref.line !== undefined ? `:${ref.line}` : ''} in the right sidebar (builtin text viewer).`,
      };
    }

    // Degrade: directory → bounded tree; file → info + address + note.
    if (kind === 'dir') {
      const tree = await buildFileTreeText(deps.host, cwd, {
        path: baseRel ?? absPath,
        max_rows: 100,
        max_depth: 3,
      });
      return {
        kind: 'success',
        text: [
          tree,
          `sidebar address: ${address}`,
          'tip: pick a file and run /files <path>:<line> to target a line.',
          HOST_PLANE_NOTE,
        ].join('\n'),
      };
    }

    let lineCount: number | undefined;
    let targetLine: string | undefined;
    let size: number | undefined;
    let readFailed = false;
    try {
      const text = await deps.host.readText(absPath);
      size = Buffer.byteLength(text, 'utf8');
      const lines = text.split('\n');
      lineCount = lines.length;
      if (ref.line !== undefined && ref.line >= 1 && ref.line <= lines.length) {
        targetLine = lines[ref.line - 1];
      }
    } catch {
      readFailed = true;
    }

    const info = fileInfoLines(display, ref, {
      size,
      lineCount,
      targetLine,
      statusText,
      address,
      workspace: base,
    });
    if (ref.line !== undefined && targetLine === undefined && !readFailed) {
      info.push(`(line ${ref.line} is out of range)`);
    }
    if (readFailed) info.push('(content unreadable — file may be binary or oversized)');
    info.push(HOST_PLANE_NOTE);
    return { kind: 'success', text: info.join('\n') };
  };
}

/** The register-ready `/files` command definition. */
export function createFilesCommand(deps: FilesCommandDeps): {
  name: string;
  description: string;
  input: { hint: string };
  handler: (invocation: FilesInvocation) => Promise<FilesResult>;
} {
  return {
    name: 'files',
    description:
      'Show file info for a path[:line] (and open it in the right-sidebar viewer when available)',
    input: { hint: 'path[:line]' },
    handler: createFilesCommandHandler(deps),
  };
}
