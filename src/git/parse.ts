import type { Commit, Ref } from '../shared/types';

export const RECORD_SEP = '\x1e';
export const FIELD_SEP = '\x1f';

/** `git log` format string matching `parseLog`. */
export const LOG_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%D${FIELD_SEP}%s`;

export function parseLog(stdout: string, remotes: readonly string[]): Commit[] {
  const out: Commit[] = [];
  const records = stdout.split(RECORD_SEP);
  for (const rec of records) {
    if (rec.length === 0) continue;
    const f = rec.split(FIELD_SEP);
    if (f.length < 7) continue;
    const parents = f[1]!.length ? f[1]!.split(' ') : [];
    out.push({
      hash: f[0]!,
      parents,
      author: f[2]!,
      email: f[3]!,
      date: Number(f[4]),
      refs: parseDecorations(f[5]!, remotes),
      subject: f[6]!.replace(/\n$/, ''),
    });
  }
  return out;
}

/** Parses git's `%D` decoration list: `HEAD -> main, origin/main, tag: v1.0, origin/HEAD`. */
export function parseDecorations(d: string, remotes: readonly string[]): Ref[] {
  if (!d) return [];
  const refs: Ref[] = [];
  for (const raw of d.split(', ')) {
    const item = raw.trim();
    if (!item) continue;
    if (item === 'refs/stash' || item.startsWith('refs/stash')) {
      continue; // stash refs are attached separately from `git stash list`
    } else if (item === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD', isHead: true });
    } else if (item.startsWith('HEAD -> ')) {
      refs.push({ kind: 'branch', name: item.slice(8), isHead: true });
    } else if (item.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: item.slice(5) });
    } else if (item.endsWith('/HEAD') && isRemoteRef(item, remotes)) {
      continue; // origin/HEAD is noise
    } else if (isRemoteRef(item, remotes)) {
      refs.push({ kind: 'remote', name: item });
    } else {
      refs.push({ kind: 'branch', name: item });
    }
  }
  return refs;
}

function isRemoteRef(name: string, remotes: readonly string[]): boolean {
  for (const r of remotes) {
    if (name.startsWith(r + '/')) return true;
  }
  return false;
}

export interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

/** Parses `git show --name-status -z` style output (NUL separated). */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const parts = stdout.split('\0');
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i]!;
    if (!status) { i++; continue; }
    const code = status[0]!;
    if (code === 'R' || code === 'C') {
      const oldPath = parts[i + 1] ?? '';
      const path = parts[i + 2] ?? '';
      out.push({ status: code, path, oldPath });
      i += 3;
    } else {
      out.push({ status: code, path: parts[i + 1] ?? '' });
      i += 2;
    }
  }
  return out;
}

/**
 * Parses `git status --porcelain=v1 -z`. Entries are `XY path\0` and renames add `\0origpath`.
 * Status letter preference: index status, else worktree status; untracked is `?`.
 */
export function parseStatusZ(stdout: string): NameStatusEntry[] {
  const parts = stdout.split('\0');
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i]!;
    if (rec.length < 4) { i++; continue; }
    const x = rec[0]!, y = rec[1]!;
    const path = rec.slice(3);
    let status = x !== ' ' && x !== '?' ? x : y;
    if (x === '?' ) status = '?';
    if (x === 'R' || x === 'C') {
      const oldPath = parts[i + 1] ?? '';
      out.push({ status: x, path, oldPath });
      i += 2;
    } else {
      out.push({ status, path });
      i += 1;
    }
  }
  return out;
}

/**
 * Stash commits carry extra parents (index state, untracked files) that only exist to hold the
 * stash. Fold them away: drop those helper commits from the list and trim the stash's parents to
 * the base commit, so the stash draws as a single node hanging off its base.
 */
export function foldStashes(commits: Commit[], stashes: { hash: string; parents: string[] }[]): Commit[] {
  if (stashes.length === 0) return commits;
  const helpers = new Set<string>();
  const stashHashes = new Set<string>();
  for (const s of stashes) {
    stashHashes.add(s.hash);
    for (const p of s.parents.slice(1)) helpers.add(p);
  }
  const out: Commit[] = [];
  for (const c of commits) {
    if (helpers.has(c.hash)) continue;
    if (stashHashes.has(c.hash)) out.push({ ...c, parents: c.parents.slice(0, 1) });
    else out.push(c);
  }
  return out;
}

export interface RepoPaths { root: string; gitDir: string; commonDir: string }

/**
 * Resolves `git rev-parse --show-toplevel --absolute-git-dir --git-common-dir` output.
 * `--git-common-dir` is printed relative to the command's working directory (`.git` at the
 * repo root, `../.git` from a subfolder), so it must be resolved against `cwd`, not the git dir.
 */
export function parseRepoPaths(cwd: string, stdout: string, resolve: (...p: string[]) => string, isAbsolute: (p: string) => boolean): RepoPaths | undefined {
  const [root, gitDir, common] = stdout.trim().split('\n').map((s) => s.trim());
  if (!root || !gitDir) return undefined;
  const commonDir = common && isAbsolute(common) ? common : resolve(cwd, common || gitDir);
  return { root, gitDir, commonDir };
}
