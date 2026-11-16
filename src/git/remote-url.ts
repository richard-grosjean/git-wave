// Turns git remote URLs into web URLs. Pure functions, no vscode imports, so they can be unit-tested.

export interface RemoteWeb {
  host: string;
  /** Repository path on the host, e.g. `owner/repo` or `group/subgroup/repo`. */
  path: string;
}

/** Parses `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo`, `https://user@host/owner/repo.git`. */
export function parseRemoteUrl(url: string | undefined): RemoteWeb | undefined {
  if (!url) return undefined;
  const u = url.trim();
  let host: string | undefined;
  let p: string | undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  const full = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u);
  if (full) { host = full[1]; p = full[2]; }
  else if (scp) { host = scp[1]; p = scp[2]; }
  if (!host || !p) return undefined;
  p = p.replace(/\/+$/, '').replace(/\.git$/, '');
  return p ? { host: host.toLowerCase(), path: p } : undefined;
}

/**
 * The "open a pull request from `branch`" page for a remote, for GitHub, GitLab and Bitbucket
 * (including self-hosted instances whose host name says which one it is). Undefined otherwise.
 */
export function pullRequestUrl(remoteUrl: string | undefined, branch: string): string | undefined {
  const r = parseRemoteUrl(remoteUrl);
  if (!r) return undefined;
  const base = `https://${r.host}/${r.path}`;
  const b = encodeURIComponent(branch);
  if (r.host.includes('github')) return `${base}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;
  if (r.host.includes('gitlab')) return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}`;
  if (r.host.includes('bitbucket')) return `${base}/pull-requests/new?source=${b}`;
  return undefined;
}

type Host = 'github' | 'gitlab' | 'bitbucket';
function web(remoteUrl: string | undefined): { base: string; host: Host } | undefined {
  const r = parseRemoteUrl(remoteUrl);
  if (!r) return undefined;
  const host: Host | undefined = r.host.includes('github') ? 'github' : r.host.includes('gitlab') ? 'gitlab' : r.host.includes('bitbucket') ? 'bitbucket' : undefined;
  return host && { base: `https://${r.host}/${r.path}`, host };
}

/** The web page for a commit on GitHub, GitLab or Bitbucket. Undefined for other hosts. */
export function commitUrl(remoteUrl: string | undefined, hash: string): string | undefined {
  const w = web(remoteUrl);
  if (!w) return undefined;
  return w.host === 'github' ? `${w.base}/commit/${hash}` : w.host === 'gitlab' ? `${w.base}/-/commit/${hash}` : `${w.base}/commits/${hash}`;
}

/** The web page for a branch on GitHub, GitLab or Bitbucket. Undefined for other hosts. */
export function branchUrl(remoteUrl: string | undefined, branch: string): string | undefined {
  const w = web(remoteUrl);
  if (!w) return undefined;
  const b = branch.split('/').map(encodeURIComponent).join('/');
  return w.host === 'github' ? `${w.base}/tree/${b}` : w.host === 'gitlab' ? `${w.base}/-/tree/${b}` : `${w.base}/src/${b}`;
}
