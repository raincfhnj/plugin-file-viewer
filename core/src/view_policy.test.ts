import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applicableModes,
  defaultMode,
  describeFile,
  isMarkdownPath,
  nextMode,
} from './view_policy.ts';
import type { ChangedFileView, FileDescriptor, ViewMode } from './types.ts';

const PREFS: readonly ChangedFileView[] = ['diff', 'content'];

function fd(name: string, isMarkdown: boolean, isChanged: boolean): FileDescriptor {
  return { path: name, isMarkdown, isChanged, isDeleted: false };
}

function deletedFd(name: string, isMarkdown: boolean): FileDescriptor {
  return { path: name, isMarkdown, isChanged: true, isDeleted: true };
}

// view_policy.rs: unchanged_markdown_defaults_to_rendered_markdown
test('unchanged markdown defaults to rendered markdown', () => {
  for (const pref of PREFS) {
    assert.equal(defaultMode(fd('README.md', true, false), pref), 'renderedMarkdown');
  }
});

// view_policy.rs: changed_file_defaults_to_diff_even_when_markdown
test('changed file defaults to diff even when markdown', () => {
  assert.equal(defaultMode(fd('README.md', true, true), 'diff'), 'diff');
  assert.equal(defaultMode(fd('main.rs', false, true), 'diff'), 'diff');
});

// view_policy.rs: changed_file_content_preference_uses_the_normal_file_type_policy
test('changed file content preference uses the normal file type policy', () => {
  assert.equal(defaultMode(fd('README.md', true, true), 'content'), 'renderedMarkdown');
  assert.equal(defaultMode(fd('main.rs', false, true), 'content'), 'syntaxContent');
});

// view_policy.rs: deleted_file_stays_diff_first_under_content_preference
test('deleted file stays diff first under any preference', () => {
  for (const isMarkdown of [false, true]) {
    for (const pref of PREFS) {
      const name = isMarkdown ? 'gone.md' : 'gone.rs';
      assert.equal(
        defaultMode(deletedFd(name, isMarkdown), pref),
        'diff',
        `a deleted path has no on-disk content to render (md=${isMarkdown}, pref=${pref})`,
      );
    }
  }
});

// view_policy.rs: unchanged_non_markdown_defaults_to_syntax_content
test('unchanged non-markdown defaults to syntax content', () => {
  for (const pref of PREFS) {
    assert.equal(defaultMode(fd('main.rs', false, false), pref), 'syntaxContent');
  }
});

// view_policy.rs: changed_file_cycle_offers_a_full_context_diff_right_after_the_compact_diff (AC-11)
test('changed file cycle offers a full context diff right after the compact diff', () => {
  assert.deepEqual(applicableModes(fd('main.rs', false, true), 'diff'), [
    'diff',
    'fullDiff',
    'syntaxContent',
  ]);
  assert.deepEqual(applicableModes(fd('README.md', true, true), 'diff'), [
    'diff',
    'fullDiff',
    'renderedMarkdown',
    'syntaxContent',
  ]);
});

// view_policy.rs: content_preference_cycle_starts_normally_and_keeps_diff_available
test('content preference cycle starts normally and keeps diff available', () => {
  assert.deepEqual(applicableModes(fd('main.rs', false, true), 'content'), [
    'syntaxContent',
    'diff',
    'fullDiff',
  ]);
  assert.deepEqual(applicableModes(fd('README.md', true, true), 'content'), [
    'renderedMarkdown',
    'diff',
    'fullDiff',
    'syntaxContent',
  ]);
});

// view_policy.rs: unchanged_file_has_no_diff_views_in_its_cycle
test('unchanged file has no diff views in its cycle', () => {
  for (const md of [true, false]) {
    const modes = applicableModes(fd('x', md, false), 'content');
    assert.ok(!modes.includes('diff'), `no compact diff when unchanged (md=${md})`);
    assert.ok(!modes.includes('fullDiff'), `no full diff when unchanged (md=${md})`);
  }
});

// view_policy.rs: applicable_modes_start_with_the_default_so_cycling_overrides_it
test('applicable modes start with the default so cycling overrides it', () => {
  const f = fd('README.md', true, false);
  for (const pref of PREFS) {
    const modes = applicableModes(f, pref);
    assert.equal(modes[0], defaultMode(f, pref));
  }
});

// view_policy.rs: applicable_modes_have_no_duplicates
test('applicable modes have no duplicates', () => {
  const f = fd('README.md', true, true);
  for (const pref of PREFS) {
    const modes = applicableModes(f, pref);
    assert.equal(modes.length, new Set(modes).size, 'applicable modes must not repeat');
  }
});

test('cycle walks the whole sequence and wraps back to the default', () => {
  const modes = applicableModes(fd('README.md', true, true), 'diff');
  const walked: ViewMode[] = [modes[0]];
  for (let i = 1; i < modes.length; i++) {
    walked.push(nextMode(modes, walked[walked.length - 1]));
  }
  assert.deepEqual(walked, modes);
  assert.equal(nextMode(modes, modes[modes.length - 1]), modes[0], 'wrap to the default');
});

test('nextMode on an unknown current mode restarts at the default', () => {
  const modes: ViewMode[] = ['syntaxContent'];
  assert.equal(nextMode(modes, 'diff'), 'syntaxContent');
});

test('isMarkdownPath accepts md/markdown case-insensitively and nothing else', () => {
  for (const yes of ['README.md', 'docs/guide.MD', 'notes.markdown', 'a/b/File.Md']) {
    assert.equal(isMarkdownPath(yes), true, yes);
  }
  for (const no of [
    'main.rs',
    'a.mdx',
    'a.mdown',
    'a.mkd',
    'markdown',
    'md',
    'docs/.gitignore',
    'file.txt',
  ]) {
    assert.equal(isMarkdownPath(no), false, no);
  }
});

test('describeFile derives the policy facts from path + status', () => {
  assert.deepEqual(describeFile('README.md', undefined), {
    path: 'README.md',
    isMarkdown: true,
    isChanged: false,
    isDeleted: false,
  });
  assert.deepEqual(describeFile('src/main.rs', 'Modified'), {
    path: 'src/main.rs',
    isMarkdown: false,
    isChanged: true,
    isDeleted: false,
  });
  assert.deepEqual(describeFile('gone.md', 'Deleted'), {
    path: 'gone.md',
    isMarkdown: true,
    isChanged: true,
    isDeleted: true,
  });
  assert.deepEqual(describeFile('new.ts', 'Untracked'), {
    path: 'new.ts',
    isMarkdown: false,
    isChanged: true,
    isDeleted: false,
  });
});
