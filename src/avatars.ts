import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Memento } from 'vscode';
import type { Commit } from './shared/types';

const CACHE_KEY = 'gitwave.avatars.v1';
const NONE = '';

/**
 * Resolves author emails to avatar URLs.
 *  1. GitHub noreply addresses encode the user id, so they need no network.
 *  2. For repositories with a GitHub remote, the commits API gives the author's avatar.
 *     Uses the `gh` CLI token when available for a much higher rate limit.
 *  3. Otherwise Gravatar, with d=404 so the webview can fall back to initials.
 * Results are cached in globalState keyed by email.
 */
export class AvatarService {
  private cache: Record<string, string>;
  private ghToken: Promise<string | undefined> | undefined;
  private inflight = new Set<string>();

  constructor(private readonly state: Memento) {
    this.cache = state.get<Record<string, string>>(CACHE_KEY, {});
  }

  /** Returns what is already known and kicks off lookups for the rest; `onMore` fires with new entries. */
  resolve(commits: Commit[], remoteUrl: string | undefined, onMore: (found: Record<string, string>) => void): Record<string, string> {
    const known: Record<string, string> = {};
    const bySha = new Map<string, string>(); // email -> a commit sha to look up
    for (const c of commits) {
      const e = c.email.toLowerCase();
      if (!e) continue;
      const cached = this.cache[e];
      if (cached !== undefined) { if (cached !== NONE) known[e] = cached; continue; }
      const direct = noreplyAvatar(e);
      if (direct) { this.remember(e, direct); known[e] = direct; continue; }
      if (!bySha.has(e)) bySha.set(e, c.hash);
    }
    if (bySha.size > 0) void this.lookup(bySha, remoteUrl, onMore);
    return known;
  }

  private async lookup(bySha: Map<string, string>, remoteUrl: string | undefined, onMore: (found: Record<string, string>) => void): Promise<void> {
    const gh = parseGitHubRemote(remoteUrl);
    const found: Record<string, string> = {};
    const jobs: Promise<void>[] = [];
    let active = 0;
    const queue = [...bySha.entries()].filter(([e]) => !this.inflight.has(e)).slice(0, 40);
    for (const [email, sha] of queue) this.inflight.add(email);
    const next = async (): Promise<void> => {
      const item = queue.shift();
      if (!item) return;
      const [email, sha] = item;
      try {
        let url: string | undefined;
        if (gh) url = await this.githubCommitAvatar(gh.owner, gh.repo, sha);
        if (!url) url = await gravatar(email);
        this.remember(email, url ?? NONE);
        if (url) found[email] = url;
      } catch {
        // leave uncached so a later page can retry
      } finally {
        this.inflight.delete(email);
      }
      return next();
    };
    while (active < 4 && queue.length > 0) { active++; jobs.push(next()); }
    await Promise.all(jobs);
    await this.state.update(CACHE_KEY, this.cache);
    if (Object.keys(found).length > 0) onMore(found);
  }

  private remember(email: string, url: string): void {
    this.cache[email] = url;
  }

  private async githubCommitAvatar(owner: string, repo: string, sha: string): Promise<string | undefined> {
    const token = await this.token();
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'git-wave-vscode' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) throw new Error('rate limited');
      return undefined;
    }
    const json = (await res.json()) as { author?: { avatar_url?: string } | null };
    const u = json.author?.avatar_url;
    return u ? `${u}${u.includes('?') ? '&' : '?'}s=48` : undefined;
  }

  private token(): Promise<string | undefined> {
    if (!this.ghToken) {
      this.ghToken = new Promise((resolve) => {
        execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
      });
    }
    return this.ghToken;
  }
}

export function noreplyAvatar(email: string): string | undefined {
  const m = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/.exec(email);
  return m ? `https://avatars.githubusercontent.com/u/${m[1]}?s=48&v=4` : undefined;
}

export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | undefined {
  if (!url) return undefined;
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

async function gravatar(email: string): Promise<string | undefined> {
  const hash = createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  const url = `https://www.gravatar.com/avatar/${hash}?s=48&d=404`;
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  return res.ok ? url : undefined;
}
