import type { Worktree } from '../shared/types';

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(stdout: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | null = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const line of stdout.split('\n')) {
    if (line === '') { flush(); continue; }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    switch (key) {
      case 'worktree':
        flush();
        cur = { path: val, head: '', detached: false, bare: false, isMain: out.length === 0, locked: false };
        break;
      case 'HEAD': if (cur) cur.head = val; break;
      case 'branch': if (cur) cur.branch = val; break;
      case 'detached': if (cur) cur.detached = true; break;
      case 'bare': if (cur) cur.bare = true; break;
      case 'locked':
        if (cur) { cur.locked = true; if (val) cur.lockReason = val; }
        break;
      case 'prunable': if (cur) cur.prunable = val || 'prunable'; break;
      default: break;
    }
  }
  flush();
  return out;
}

export function shortBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
}
