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
    if (item === 'HEAD') {
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
