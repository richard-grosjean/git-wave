import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from './exec';
import { LOG_FORMAT, parseBranchTracking, parseLog, parseNameStatusZ, parseRepoPaths, parseStatusZ } from './parse';
import { parseWorktreeList } from './worktree-parse';
import type { BranchTracking, Commit, OperationKind, OperationState, CommitDetail, CommitFile, Stash, Worktree } from '../shared/types';

export interface LogOptions {
  skip: number;
  maxCount: number;
  remotes: boolean;
  tags: boolean;
  /** Extra revisions to include (e.g. stash commits). */
  extraRevs?: string[];
}

/** A git working tree (main or linked) that the UI can show a graph for. */
export class Repository implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Refs, HEAD, or worktree metadata changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeWorkingTree = new vscode.EventEmitter<void>();
  /** Files in the working tree or the index changed. */
  readonly onDidChangeWorkingTree = this._onDidChangeWorkingTree.event;
  private wtWatcher: vscode.FileSystemWatcher | undefined;
  private wtDebounce: NodeJS.Timeout | undefined;
  private watcher: fs.FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private remoteNames: string[] | undefined;
  /** Bumped when config changes, so a `git remote` started before the change can't cache its stale answer. */
  private remoteGen = 0;
  /** Linked worktrees that live inside this working tree, as relative paths (e.g. `.claude/worktrees/task`). */
  private nestedWorktrees: string[] | undefined;

  private constructor(readonly root: string, readonly gitDir: string, readonly commonDir: string) {}

  static async open(folder: string): Promise<Repository | undefined> {
    try {
      const { stdout } = await git(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
      const paths = parseRepoPaths(folder, stdout, path.resolve, path.isAbsolute);
      if (!paths) return undefined;
      const repo = new Repository(paths.root, paths.gitDir, paths.commonDir);
      repo.watch();
      return repo;
    } catch {
      return undefined;
    }
  }

  get label(): string {
    return path.basename(this.root);
  }

  async remotes(): Promise<string[]> {
    if (this.remoteNames) return this.remoteNames;
    const gen = this.remoteGen;
    const { stdout } = await git(this.root, ['remote']);
    const names = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (gen === this.remoteGen) this.remoteNames = names;
    return names;
  }

  async log(opts: LogOptions, token?: vscode.CancellationToken): Promise<{ commits: Commit[]; hasMore: boolean }> {
    const remotes = await this.remotes();
    const args = [
      'log', '--date-order', `--format=${LOG_FORMAT}`,
      `--max-count=${opts.maxCount + 1}`, `--skip=${opts.skip}`,
      '--exclude=refs/stash', '--exclude=refs/notes/*',
    ];
    if (!opts.remotes) args.push('--exclude=refs/remotes/*');
    if (!opts.tags) args.push('--exclude=refs/tags/*');
    args.push('--all', ...(opts.extraRevs ?? []));
    const { stdout } = await git(this.root, args, { token });
    const commits = parseLog(stdout, remotes);
    const hasMore = commits.length > opts.maxCount;
    if (hasMore) commits.pop();
    return { commits, hasMore };
  }

  async detail(hash: string): Promise<CommitDetail> {
    const sep = '\x1f';
    const [meta, files] = await Promise.all([
      git(this.root, ['show', '--no-patch', `--format=%cn${sep}%ct${sep}%B`, hash]),
      git(this.root, ['show', '--name-status', '-z', '--format=', '-m', '--first-parent', hash]),
    ]);
    const [committer, committerDate, body] = meta.stdout.split(sep);
    return {
      hash,
      committer: committer ?? '',
      committerDate: Number(committerDate ?? 0),
      body: (body ?? '').replace(/\n+$/, ''),
      files: parseNameStatusZ(files.stdout),
    };
  }

  async fileAt(hash: string, relPath: string): Promise<string> {
    const { stdout } = await git(this.root, ['show', `${hash}:${relPath}`]);
    return stdout;
  }

  async worktrees(): Promise<Worktree[]> {
    const { stdout } = await git(this.root, ['worktree', 'list', '--porcelain']);
    const list = parseWorktreeList(stdout);
    this.nestedWorktrees = list
      .filter((w) => !w.isMain && w.path !== this.root)
      .map((w) => path.relative(this.root, w.path))
      .filter((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    return list;
  }

  /** Is this absolute path inside a linked worktree nested in this working tree? */
  private inNestedWorktree(abs: string): boolean {
    const rel = path.relative(this.root, abs);
    return (this.nestedWorktrees ?? []).some((n) => rel === n || rel.startsWith(n + path.sep));
  }

  worktreeLock(wtPath: string, reason?: string): Promise<unknown> {
    const args = ['worktree', 'lock'];
    if (reason) args.push('--reason', reason);
    args.push(wtPath);
    return git(this.root, args);
  }

  worktreeUnlock(wtPath: string): Promise<unknown> {
    return git(this.root, ['worktree', 'unlock', wtPath]);
  }

  worktreeRemove(wtPath: string, force: boolean): Promise<unknown> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(wtPath);
    return git(this.root, args);
  }

  worktreePrune(): Promise<unknown> {
    return git(this.root, ['worktree', 'prune']);
  }

  /**
   * `git worktree add`. With `branch` + `newBranch` creates the branch at `startPoint` (default HEAD), optionally
   * tracking it; with just `branch` checks out an existing branch; without `branch` makes a detached worktree.
   */
  async worktreeAdd(wtPath: string, o: { branch?: string; newBranch?: boolean; startPoint?: string; track?: boolean } = {}): Promise<unknown> {
    const args = ['worktree', 'add'];
    if (o.branch && o.newBranch) args.push(...(o.track ? ['--track'] : []), '-b', o.branch, wtPath);
    else if (o.branch) args.push(wtPath, o.branch);
    else args.push('--detach', wtPath);
    if (o.startPoint && (o.newBranch || !o.branch)) args.push(o.startPoint);
    return git(this.root, args);
  }

  async branches(): Promise<string[]> {
    const { stdout } = await git(this.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Local branches with their upstream and ahead/behind counts (relative to the last fetch). */
  async branchTracking(): Promise<Map<string, BranchTracking>> {
    const { stdout } = await git(this.root, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)', 'refs/heads/']);
    return parseBranchTracking(stdout);
  }

  async remoteBranches(): Promise<string[]> {
    const { stdout } = await git(this.root, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']);
    const remotes = await this.remotes();
    // Skip `origin/HEAD` and bare `origin` (how a symbolic remote HEAD can show up).
    return stdout.split('\n').map((s) => s.trim()).filter((s) => s && !remotes.includes(s) && !s.endsWith('/HEAD'));
  }

  /** Splits `origin/feat/x` into its configured remote and branch; remote names may contain `/`. */
  async splitRemoteRef(remoteBranch: string): Promise<{ remote: string; branch: string } | undefined> {
    const remote = [...await this.remotes()].sort((a, b) => b.length - a.length).find((r) => remoteBranch.startsWith(`${r}/`));
    return remote ? { remote, branch: remoteBranch.slice(remote.length + 1) } : undefined;
  }

  // ---------- working tree / stashes ----------

  async headHash(): Promise<string | undefined> {
    try {
      const { stdout } = await git(this.root, ['rev-parse', '--verify', '-q', 'HEAD']);
      return stdout.trim() || undefined;
    } catch {
      return undefined; // unborn branch
    }
  }

  async currentBranch(): Promise<string | undefined> {
    const { stdout } = await git(this.root, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => ({ stdout: '' }));
    return stdout.trim() || undefined;
  }

  /** Changed files in the working tree and index (`git status --porcelain -z`). */
  async status(): Promise<CommitFile[]> {
    if (this.nestedWorktrees === undefined) await this.worktrees().catch(() => undefined);
    // Worktrees checked out inside this tree are untracked from git's point of view, but they are
    // not "our" changes; exclude them so the uncommitted row only shows this worktree's files.
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...this.nestedWorktreeExcludes()];
    const { stdout } = await git(this.root, args);
    return parseStatusZ(stdout);
  }

  /** Pathspec (`-- . :(exclude)…`) leaving out linked worktrees nested in this tree; empty when there are none. */
  private nestedWorktreeExcludes(): string[] {
    const exclude = (this.nestedWorktrees ?? []).map((n) => `:(exclude)${n.split(path.sep).join('/')}`);
    return exclude.length ? ['--', '.', ...exclude] : [];
  }

  stashPush(message: string | undefined, includeUntracked: boolean): Promise<unknown> {
    const args = ['stash', 'push'];
    if (includeUntracked) args.push('--include-untracked');
    if (message) args.push('-m', message);
    return git(this.root, [...args, ...this.nestedWorktreeExcludes()]);
  }

  /** Discards changes to tracked files (`reset --hard`), and with `untracked` also removes untracked files (`clean -fd`). */
  async discardChanges(untracked: boolean): Promise<void> {
    await git(this.root, ['reset', '--hard', 'HEAD']);
    if (untracked) {
      if (this.nestedWorktrees === undefined) await this.worktrees();
      await git(this.root, ['clean', '-fd', ...this.nestedWorktreeExcludes()]);
    }
  }

  async stashes(): Promise<Stash[]> {
    const { stdout } = await git(this.root, ['stash', 'list', '--format=%H%x1f%gd%x1f%P%x1f%gs']).catch(() => ({ stdout: '' }));
    const out: Stash[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      const [hash, ref, parents, subject] = line.split('\x1f');
      if (!hash || !ref) continue;
      const m = /^stash@\{(\d+)\}$/.exec(ref);
      out.push({ hash, index: m ? Number(m[1]) : out.length, parents: (parents ?? '').split(' ').filter(Boolean), message: subject ?? '' });
    }
    return out;
  }

  stashApply(index: number): Promise<unknown> { return git(this.root, ['stash', 'apply', `stash@{${index}}`]); }
  stashPop(index: number): Promise<unknown> { return git(this.root, ['stash', 'pop', `stash@{${index}}`]); }
  stashDrop(index: number): Promise<unknown> { return git(this.root, ['stash', 'drop', `stash@{${index}}`]); }

  // ---------- refs / history actions ----------

  checkout(ref: string): Promise<unknown> { return git(this.root, ['checkout', ref]); }
  checkoutTracking(remoteBranch: string): Promise<unknown> { return git(this.root, ['checkout', '--track', remoteBranch]); }
  createBranch(name: string, at: string, checkout: boolean): Promise<unknown> {
    return checkout ? git(this.root, ['checkout', '-b', name, at]) : git(this.root, ['branch', name, at]);
  }
  deleteBranch(name: string, force: boolean): Promise<unknown> { return git(this.root, ['branch', force ? '-D' : '-d', name]); }
  /** Deletes `branch` on `remote` (`git push <remote> --delete <branch>`). */
  deleteRemoteBranch(remote: string, branch: string): Promise<unknown> { return git(this.root, ['push', remote, '--delete', branch]); }
  deleteRemoteTag(remote: string, tag: string): Promise<unknown> { return git(this.root, ['push', remote, '--delete', `refs/tags/${tag}`]); }
  /** Pushes `branch` to `remote` as `remoteBranch`; `setUpstream` adds `-u`, `force` uses `--force-with-lease`. */
  push(branch: string, remote: string, remoteBranch: string, o: { setUpstream?: boolean; force?: boolean } = {}): Promise<unknown> {
    const args = ['push'];
    if (o.setUpstream) args.push('-u');
    if (o.force) args.push('--force-with-lease');
    return git(this.root, [...args, remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`]);
  }
  /** `git pull` in a working tree (this one by default). */
  pull(cwd = this.root): Promise<unknown> { return git(cwd, ['pull']); }
  /** Fast-forwards a branch that isn't checked out from its upstream (`git fetch <remote> <rb>:<branch>`). */
  fastForward(branch: string, remote: string, remoteBranch: string): Promise<unknown> {
    return git(this.root, ['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${branch}`]);
  }
  setUpstream(branch: string, upstream: string | undefined): Promise<unknown> {
    return git(this.root, upstream ? ['branch', `--set-upstream-to=${upstream}`, branch] : ['branch', '--unset-upstream', branch]);
  }
  /** Drops the local remote-tracking ref only (`git branch -dr <remote>/<branch>`). */
  deleteRemoteTrackingRef(remoteBranch: string): Promise<unknown> { return git(this.root, ['branch', '-dr', remoteBranch]); }
  renameBranch(from: string, to: string): Promise<unknown> { return git(this.root, ['branch', '-m', from, to]); }
  merge(ref: string, mode: 'default' | 'no-ff' | 'squash' | 'ff-only'): Promise<unknown> {
    const args = ['merge'];
    if (mode === 'no-ff') args.push('--no-ff');
    else if (mode === 'squash') args.push('--squash');
    else if (mode === 'ff-only') args.push('--ff-only');
    args.push('--no-edit', ref);
    return git(this.root, args);
  }
  rebase(onto: string): Promise<unknown> { return git(this.root, ['rebase', onto]); }
  cherryPick(hash: string, noCommit: boolean): Promise<unknown> {
    return git(this.root, noCommit ? ['cherry-pick', '--no-commit', hash] : ['cherry-pick', hash]);
  }
  revert(hash: string): Promise<unknown> { return git(this.root, ['revert', '--no-edit', hash]); }
  reset(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<unknown> { return git(this.root, ['reset', `--${mode}`, hash]); }
  createTag(name: string, at: string, message?: string): Promise<unknown> {
    return message ? git(this.root, ['tag', '-a', name, '-m', message, at]) : git(this.root, ['tag', name, at]);
  }
  deleteTag(name: string): Promise<unknown> { return git(this.root, ['tag', '-d', name]); }
  fetch(): Promise<unknown> { return git(this.root, ['fetch', '--all', '--prune']); }

  async remoteUrl(name = 'origin'): Promise<string | undefined> {
    const { stdout } = await git(this.root, ['remote', 'get-url', name]).catch(() => ({ stdout: '' }));
    return stdout.trim() || undefined;
  }

  /** The merge / rebase / cherry-pick / revert in progress in this worktree, if any. */
  async operationState(): Promise<OperationState | undefined> {
    const at = (f: string) => path.join(this.gitDir, f);
    const exists = (f: string) => fs.promises.access(at(f)).then(() => true, () => false);
    const read = (f: string) => fs.promises.readFile(at(f), 'utf8').then((s) => s.trim(), () => '');
    let op: OperationState | undefined;
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      if (!(await exists(dir))) continue;
      const merge = dir === 'rebase-merge';
      // rebase-apply also backs `git am`; only treat it as a rebase when git says so.
      if (!merge && !(await exists('rebase-apply/rebasing'))) continue;
      const step = Number(await read(merge ? 'rebase-merge/msgnum' : 'rebase-apply/next')) || undefined;
      const total = Number(await read(merge ? 'rebase-merge/end' : 'rebase-apply/last')) || undefined;
      const branch = (await read(`${dir}/head-name`)).replace(/^refs\/heads\//, '') || undefined;
      op = { kind: 'rebase', conflicts: 0, step, total, branch };
      break;
    }
    if (!op) {
      const heads: [string, OperationKind][] = [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']];
      for (const [file, kind] of heads) if (await exists(file)) { op = { kind, conflicts: 0 }; break; }
    }
    if (!op) return undefined;
    const { stdout } = await git(this.root, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }));
    op.conflicts = stdout.split('\n').filter(Boolean).length;
    return op;
  }

  /** `git <kind> --continue|--skip|--abort`; continue keeps git's prepared commit message instead of opening an editor. */
  operation(kind: OperationKind, action: 'continue' | 'skip' | 'abort'): Promise<unknown> {
    return git(this.root, [...(action === 'continue' ? ['-c', 'core.editor=true'] : []), kind, `--${action}`]);
  }

  /** URL of the first remote on GitHub (origin first), else origin's URL. Used for avatar lookups. */
  async avatarRemoteUrl(): Promise<string | undefined> {
    const remotes = [...await this.remotes()].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : 0));
    let first: string | undefined;
    for (const r of remotes) {
      const url = await this.remoteUrl(r);
      first ??= url;
      if (url && /github\.com[:/]/i.test(url)) return url;
    }
    return first;
  }

  /** Watch the shared git dir (refs, HEAD, worktree metadata) and fire a debounced change event. */
  private watch(): void {
    try {
      this.watcher = fs.watch(this.commonDir, { recursive: true }, (_ev, file) => {
        const f = typeof file === 'string' ? file : '';
        // Ignore index churn and our own lock files; refs/HEAD/packed-refs/worktrees are what matter.
        if (f.endsWith('.lock') || f.startsWith('objects')) return;
        // Remotes live in config; re-read them so a new remote's branches aren't taken for local ones.
        if (f === 'config') this.invalidateRemotes();
        if (f === 'index' || f.endsWith('/index') || f.endsWith('\\index')) { this.fireWorkingTree(); return; }
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this._onDidChange.fire(), 300);
      });
      this.watcher.on('error', () => { /* best effort */ });
    } catch {
      // Recursive watch unsupported: fall back to a VS Code watcher on refs.
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.commonDir, '{HEAD,packed-refs,config,*_HEAD,refs/**,worktrees/**,rebase-merge/**,rebase-apply/**}'));
      const fire = (u?: vscode.Uri) => {
        if (u && path.basename(u.fsPath) === 'config') this.invalidateRemotes();
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this._onDidChange.fire(), 300);
      };
      w.onDidChange(fire); w.onDidCreate(fire); w.onDidDelete(fire);
      this.fallback = w;
    }
  }
  private fallback: vscode.Disposable | undefined;

  private invalidateRemotes(): void {
    this.remoteNames = undefined;
    this.remoteGen++;
  }

  private fireWorkingTree(): void {
    if (this.wtDebounce) clearTimeout(this.wtDebounce);
    this.wtDebounce = setTimeout(() => this._onDidChangeWorkingTree.fire(), 500);
  }

  /** Start watching the working tree (VS Code's watcher honours files.watcherExclude). Idempotent. */
  watchWorkingTree(): void {
    if (this.wtWatcher) return;
    this.wtWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
    // Edits inside a nested worktree belong to that worktree; its git dir is watched via commonDir.
    const onFs = (u: vscode.Uri) => {
      if (u.fsPath.includes(`${path.sep}.git${path.sep}`) || this.inNestedWorktree(u.fsPath)) return;
      this.fireWorkingTree();
    };
    this.wtWatcher.onDidChange(onFs); this.wtWatcher.onDidCreate(onFs); this.wtWatcher.onDidDelete(onFs);
  }

  dispose(): void {
    this.watcher?.close();
    this.fallback?.dispose();
    this.wtWatcher?.dispose();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.wtDebounce) clearTimeout(this.wtDebounce);
    this._onDidChange.dispose();
    this._onDidChangeWorkingTree.dispose();
  }
}

/** Finds repositories for all workspace folders, de-duplicated by root. */
export async function discoverRepositories(): Promise<Repository[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = new Map<string, Repository>();
  for (const f of folders) {
    if (f.uri.scheme !== 'file') continue;
    const repo = await Repository.open(f.uri.fsPath);
    if (repo && !found.has(repo.root)) found.set(repo.root, repo);
    else repo?.dispose();
  }
  return [...found.values()];
}
