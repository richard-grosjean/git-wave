import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseBranchTracking, parseDecorations, parseLog, parseNameStatusZ, parseRepoPaths, FIELD_SEP, RECORD_SEP } from '../src/git/parse.js';
import { parseWorktreeList } from '../src/git/worktree-parse.js';

test('parseDecorations classifies refs', () => {
  const refs = parseDecorations('HEAD -> main, origin/main, tag: v1.0, origin/HEAD, feature/x', ['origin']);
  assert.deepEqual(refs, [
    { kind: 'branch', name: 'main', isHead: true },
    { kind: 'remote', name: 'origin/main' },
    { kind: 'tag', name: 'v1.0' },
    { kind: 'branch', name: 'feature/x' },
  ]);
  assert.deepEqual(parseDecorations('HEAD', []), [{ kind: 'head', name: 'HEAD', isHead: true }]);
  assert.deepEqual(parseDecorations('refs/stash, main', []), [{ kind: 'branch', name: 'main' }]);
  assert.deepEqual(parseDecorations('', []), []);
});

test('parseLog reads records', () => {
  const rec = (h: string, p: string, s: string) => `${RECORD_SEP}${h}${FIELD_SEP}${p}${FIELD_SEP}Ann${FIELD_SEP}a@x${FIELD_SEP}1700000000${FIELD_SEP}${FIELD_SEP}${s}\n`;
  const commits = parseLog(rec('aaa', 'bbb ccc', 'merge') + rec('bbb', '', 'root'), []);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0]!.parents, ['bbb', 'ccc']);
  assert.equal(commits[0]!.subject, 'merge');
  assert.deepEqual(commits[1]!.parents, []);
  assert.equal(commits[1]!.date, 1700000000);
});

test('parseNameStatusZ handles renames', () => {
  const files = parseNameStatusZ('M\0a.ts\0R100\0old.ts\0new.ts\0A\0c.ts\0');
  assert.deepEqual(files, [
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
    { status: 'A', path: 'c.ts' },
  ]);
});

test('parseWorktreeList reads porcelain output', () => {
  const out = parseWorktreeList([
    'worktree /repo', 'HEAD aaaa', 'branch refs/heads/main', '',
    'worktree /repo-wt', 'HEAD bbbb', 'detached', 'locked keep me', '',
    'worktree /repo-gone', 'HEAD cccc', 'branch refs/heads/x', 'locked', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'));
  assert.equal(out.length, 3);
  assert.equal(out[0]!.isMain, true);
  assert.equal(out[0]!.branch, 'refs/heads/main');
  assert.equal(out[1]!.detached, true);
  assert.equal(out[1]!.locked, true);
  assert.equal(out[1]!.lockReason, 'keep me');
  assert.equal(out[2]!.locked, true);
  assert.equal(out[2]!.lockReason, undefined);
  assert.match(out[2]!.prunable!, /non-existent/);
});

test('parseStatusZ reads porcelain v1 with renames and untracked', async () => {
  const { parseStatusZ } = await import('../src/git/parse.js');
  const files = parseStatusZ(' M src/a.ts\0M  src/b.ts\0R  new.ts\0old.ts\0?? junk.txt\0D  gone.ts\0');
  assert.deepEqual(files, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'M', path: 'src/b.ts' },
    { status: 'R', path: 'new.ts', oldPath: 'old.ts' },
    { status: '?', path: 'junk.txt' },
    { status: 'D', path: 'gone.ts' },
  ]);
});

test('foldStashes drops helper commits and trims stash parents', async () => {
  const { foldStashes } = await import('../src/git/parse.js');
  const mk = (hash: string, parents: string[]) => ({ hash, parents, author: '', email: '', date: 0, subject: hash, refs: [] });
  const commits = [mk('stash', ['base', 'index', 'untracked']), mk('index', ['base']), mk('untracked', []), mk('base', [])];
  const out = foldStashes(commits, [{ hash: 'stash', parents: ['base', 'index', 'untracked'] }]);
  assert.deepEqual(out.map((c) => c.hash), ['stash', 'base']);
  assert.deepEqual(out[0]!.parents, ['base']);
});

test('parseRepoPaths resolves a relative common dir against the cwd, not the git dir', () => {
  const resolve = (...p: string[]) => path.posix.resolve(...p);
  const isAbs = (p: string) => path.posix.isAbsolute(p);
  // Main worktree opened at its root: git prints `.git`.
  assert.deepEqual(parseRepoPaths('/w/site', '/w/site\n/w/site/.git\n.git\n', resolve, isAbs),
    { root: '/w/site', gitDir: '/w/site/.git', commonDir: '/w/site/.git' });
  // Workspace folder is a subfolder: git prints `../.git`.
  assert.deepEqual(parseRepoPaths('/w/site/src', '/w/site\n/w/site/.git\n../.git\n', resolve, isAbs),
    { root: '/w/site', gitDir: '/w/site/.git', commonDir: '/w/site/.git' });
  // Linked worktree: common dir is absolute and points at the main repo.
  assert.deepEqual(parseRepoPaths('/w/wt', '/w/wt\n/w/site/.git/worktrees/wt\n/w/site/.git\n', resolve, isAbs),
    { root: '/w/wt', gitDir: '/w/site/.git/worktrees/wt', commonDir: '/w/site/.git' });
  assert.equal(parseRepoPaths('/w', '\n', resolve, isAbs), undefined);
});

test('parseBranchTracking reads upstream and ahead/behind', () => {
  const t = parseBranchTracking('main\0origin/main\0ahead 2, behind 1\nfeat\0origin/feat\0gone\nlocal\0\0\nsync\0origin/sync\0\n');
  assert.deepEqual(t.get('main'), { upstream: 'origin/main', ahead: 2, behind: 1 });
  assert.deepEqual(t.get('feat'), { upstream: 'origin/feat', gone: true });
  assert.deepEqual(t.get('local'), {});
  assert.deepEqual(t.get('sync'), { upstream: 'origin/sync' });
});
