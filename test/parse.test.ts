import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecorations, parseLog, parseNameStatusZ, FIELD_SEP, RECORD_SEP } from '../src/git/parse.js';
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
