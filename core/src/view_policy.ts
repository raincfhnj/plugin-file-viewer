/**
 * View policy — which content-pane view mode a file gets.
 * Port of herdr-file-viewer src/view_policy.rs (semantics + test coverage: ★B).
 */
import type { ChangedFileView, FileDescriptor, ViewMode } from './types.ts';

/** True when the path names a markdown file: extension `md`/`markdown`, ASCII case-insensitive
 * (Rust reference: controller::is_markdown — mdx/mdown/mkd are *not* markdown there either). */
export function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false; // no extension, or a dotfile (".gitignore" → Rust Path::extension → None)
  const ext = name.slice(dot + 1).toLowerCase();
  return ext === 'md' || ext === 'markdown';
}

/** Build the facts the policy needs from a path + cached status. */
export function describeFile(
  path: string,
  status: 'Modified' | 'Added' | 'Deleted' | 'Untracked' | undefined,
): FileDescriptor {
  return {
    path,
    isMarkdown: isMarkdownPath(path),
    isChanged: status !== undefined,
    isDeleted: status === 'Deleted',
  };
}

/** The normal non-Git view mode for a file, based only on its type. */
function contentMode(fd: FileDescriptor): ViewMode {
  return fd.isMarkdown ? 'renderedMarkdown' : 'syntaxContent';
}

/** The auto-selected default view mode for a file. */
export function defaultMode(fd: FileDescriptor, pref: ChangedFileView): ViewMode {
  if (fd.isChanged && (fd.isDeleted || pref === 'diff')) return 'diff';
  return contentMode(fd);
}

/** The modes a cycle key steps through for a file, default first (AC-11). */
export function applicableModes(fd: FileDescriptor, pref: ChangedFileView): ViewMode[] {
  const modes: ViewMode[] = [defaultMode(fd, pref)];
  const add = (m: ViewMode) => { if (!modes.includes(m)) modes.push(m); };
  if (fd.isChanged) { add('diff'); add('fullDiff'); }
  if (fd.isMarkdown) add('renderedMarkdown');
  add('syntaxContent');
  return modes;
}

/** Advance within the cycle; wraps. */
export function nextMode(modes: ViewMode[], current: ViewMode): ViewMode {
  const i = modes.indexOf(current);
  return modes[(i + 1) % modes.length];
}
