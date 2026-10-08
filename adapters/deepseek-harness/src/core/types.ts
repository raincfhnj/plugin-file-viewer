/**
 * Platform-agnostic contracts for the file viewer.
 * Ported from herdr-file-viewer (Rust) — see ARCHITECTURE.md for the mapping.
 *
 * Rules:
 * - All paths are repo-root-relative, POSIX-style ('src/main.rs'), except where noted.
 * - Pure data only: no I/O, no classes with behavior beyond data.
 * - Adapters (claude-code, codex, opencode, deepseek-harness) import these types;
 *   they must never be changed without updating ARCHITECTURE.md.
 */

/** A file's git status against the working tree (git.rs: Status). */
export type GitStatus = 'Modified' | 'Added' | 'Deleted' | 'Untracked';

/** What a diff and "changed" compare against (git.rs: Baseline). */
export type Baseline = 'HEAD' | 'Base';

/** Whether a tree node is a directory or a file (tree.rs: NodeKind). */
export type NodeKind = 'dir' | 'file';

/** One visible row of the tree (tree.rs: Node). */
export interface TreeNode {
  /** Repo-root-relative path, POSIX separators. For compacted chains, the deepest dir. */
  path: string;
  kind: NodeKind;
  depth: number;
  expanded: boolean;
  /** Per-file git status for tree markers; undefined = clean. */
  status?: GitStatus;
  /** Dir only: any file under it has a git status. Always false for files. */
  dirDirty: boolean;
  /** Display override when not the path's final component (compacted chain label). */
  label?: string;
}

/** The facts view policy needs about a file — no I/O (view_policy.rs: FileDescriptor). */
export interface FileDescriptor {
  /** Repo-root-relative path. */
  path: string;
  isMarkdown: boolean;
  isChanged: boolean;
  /** Cached git status says deleted → no content to render. */
  isDeleted: boolean;
}

/** Which rendering the content pane shows (view_policy.rs: ViewMode). */
export type ViewMode = 'renderedMarkdown' | 'diff' | 'fullDiff' | 'syntaxContent';

/** Which policy changed files use for their automatic initial view (ChangedFileView). */
export type ChangedFileView = 'diff' | 'content';

/** A directory listing entry produced by Host.listDir. */
export interface DirEntry {
  /** Entry name within its directory (no separator). */
  name: string;
  kind: NodeKind;
  /** Present for files when the host knows it. */
  size?: number;
}

/** Result of a git invocation; degraded to exitCode -1 when git is unavailable. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The I/O surface core logic needs. Adapters implement this on top of their host
 * (claude-code: $.fs / $.process.run; codex/opencode: node:fs / child_process;
 * dsh: fs + child_process). Core never imports node:fs or spawns processes itself.
 */
export interface Host {
  /** Session working directory (absolute). */
  cwd(): string;
  /** true on Windows — drives null-device and path handling. */
  isWindows: boolean;
  /** List one directory level. Relative paths resolve against cwd(). Missing dir → []. */
  listDir(relPath: string): Promise<DirEntry[]>;
  /** Read a UTF-8 text file (adapters cap at 4 MiB; oversized → throw). */
  readText(relPath: string): Promise<string>;
  /** True when the path exists (file or dir). */
  exists(relPath: string): Promise<boolean>;
  /**
   * Run a read-only git command in the given absolute dir, e.g.
   * runGit(dir, ['status','--porcelain=v1','-z','-uall']).
   * Adapters MUST pass git safety flags (see git.ts SAFE_GIT_FLAGS) and MUST NOT
   * use a shell. Failure/non-repo → { exitCode: -1, stdout: '', stderr }.
   * Timeout: 30s default.
   */
  runGit(dir: string, args: string[]): Promise<RunResult>;
}

/** A parsed `path:line` reference (for opening files at a line). */
export interface FileRef {
  path: string;
  line?: number;
}

/** Parse "src/app.rs:42" / "src/app.rs" → FileRef. Pure. */
export function parseFileRef(input: string): FileRef {
  const m = /^(.*?)(?::(\d+))?$/.exec(input.trim())!;
  const path = m[1] ?? '';
  const line = m[2] ? Number(m[2]) : undefined;
  return line === undefined ? { path } : { path, line };
}
