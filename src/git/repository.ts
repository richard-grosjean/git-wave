import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git } from './exec';
import { LOG_FORMAT, parseLog, parseNameStatusZ, parseStatusZ } from './parse';
import { parseWorktreeList } from './worktree-parse';
import type { Commit, CommitDetail, CommitFile, Stash, Worktree } from '../shared/types';

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

  private constructor(readonly root: string, readonly gitDir: string, readonly commonDir: string) {}

  static async open(folder: string): Promise<Repository | undefined> {
    try {
      const { stdout } = await git(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
      const [root, gitDir, common] = stdout.trim().split('\n');
      if (!root || !gitDir) return undefined;
      const commonDir = path.isAbsolute(common ?? '') ? common! : path.resolve(gitDir, common ?? '.');
      const repo = new Repository(root, gitDir, commonDir);
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
    if (!this.remoteNames) {
      const { stdout } = await git(this.root, ['remote']);
      this.remoteNames = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    return this.remoteNames;
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
    return parseWorktreeList(stdout);
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

  async worktreeAdd(wtPath: string, branch: string | undefined, newBranch: boolean): Promise<unknown> {
    const args = ['worktree', 'add'];
    if (branch && newBranch) args.push('-b', branch, wtPath);
    else if (branch) args.push(wtPath, branch);
    else args.push('--detach', wtPath);
    return git(this.root, args);
  }

  async branches(): Promise<string[]> {
    const { stdout } = await git(this.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
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
    const { stdout } = await git(this.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return parseStatusZ(stdout);
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

  /** Watch the shared git dir (refs, HEAD, worktree metadata) and fire a debounced change event. */
  private watch(): void {
    try {
      this.watcher = fs.watch(this.commonDir, { recursive: true }, (_ev, file) => {
        const f = typeof file === 'string' ? file : '';
        // Ignore index churn and our own lock files; refs/HEAD/packed-refs/worktrees are what matter.
        if (f.endsWith('.lock') || f.startsWith('objects')) return;
        if (f === 'index' || f.endsWith('/index') || f.endsWith('\\index')) { this.fireWorkingTree(); return; }
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this._onDidChange.fire(), 300);
      });
      this.watcher.on('error', () => { /* best effort */ });
    } catch {
      // Recursive watch unsupported: fall back to a VS Code watcher on refs.
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.commonDir, '{HEAD,packed-refs,refs/**,worktrees/**}'));
      const fire = () => { if (this.debounce) clearTimeout(this.debounce); this.debounce = setTimeout(() => this._onDidChange.fire(), 300); };
      w.onDidChange(fire); w.onDidCreate(fire); w.onDidDelete(fire);
      this.fallback = w;
    }
  }
  private fallback: vscode.Disposable | undefined;

  private fireWorkingTree(): void {
    if (this.wtDebounce) clearTimeout(this.wtDebounce);
    this.wtDebounce = setTimeout(() => this._onDidChangeWorkingTree.fire(), 500);
  }

  /** Start watching the working tree (VS Code's watcher honours files.watcherExclude). Idempotent. */
  watchWorkingTree(): void {
    if (this.wtWatcher) return;
    this.wtWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
    const onFs = (u: vscode.Uri) => { if (!u.fsPath.includes(`${path.sep}.git${path.sep}`)) this.fireWorkingTree(); };
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
