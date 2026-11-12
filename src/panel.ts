import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AvatarService } from './avatars';
import { GitFileProvider } from './fileProvider';
import type { Repository } from './git/repository';
import { foldStashes } from './git/parse';
import { shortBranch } from './git/worktree-parse';
import { GraphLayout } from './graph/layout';
import { UNCOMMITTED, type BranchTracking, type Commit, type CommitFile, type GraphConfig, type HostMessage, type Stash, type WebviewMessage, type Worktree } from './shared/types';
import { isCurrentWorktree, type WorktreeActions } from './worktreeCommands';

/** Cap on how many already-loaded commits a background reload refetches at once. */
const MAX_RELOAD_DEPTH = 5000;

export const VIEW_TYPE = 'gitwave.graph';

export class GraphPanel implements vscode.Disposable {
  static current: GraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private repo: Repository | undefined;
  private layout = new GraphLayout();
  private loaded = 0;
  private hasMore = false;
  private loading = false;
  private generation = 0;
  private cts: vscode.CancellationTokenSource | undefined;
  private worktrees: Worktree[] = [];
  private stashes: Stash[] = [];
  private statusFiles: CommitFile[] = [];
  private tracking = new Map<string, BranchTracking>();
  private repoSubs: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext, repos: Repository[], actions: WorktreeActions, avatars: AvatarService, preferred?: Repository): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      GraphPanel.current.setRepositories(repos, preferred);
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Git Wave', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    panel.iconPath = {
      light: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'tab-light.svg'),
      dark: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'tab-dark.svg'),
    };
    GraphPanel.current = new GraphPanel(ctx, panel, repos, actions, avatars, preferred);
    return GraphPanel.current;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    private repos: Repository[],
    private readonly actions: WorktreeActions,
    private readonly avatars: AvatarService,
    preferred?: Repository,
  ) {
    this.panel = panel;
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitwave')) { this.post({ type: 'config', config: readConfig() }); void this.reload(); }
    }, null, this.disposables);
    this.setRepositories(repos, preferred);
  }

  /** The repository currently shown. */
  get repository(): Repository | undefined {
    return this.repo;
  }

  setRepositories(repos: Repository[], preferred?: Repository): void {
    this.repos = repos;
    const next = preferred ?? (this.repo && repos.includes(this.repo) ? this.repo : repos[0]);
    this.post({ type: 'repos', repos: repos.map((r) => ({ path: r.root, label: r.label })), current: next?.root ?? '' });
    if (next && next !== this.repo) this.switchRepo(next);
  }

  private switchRepo(repo: Repository): void {
    for (const s of this.repoSubs) s.dispose();
    this.repo = repo;
    repo.watchWorkingTree();
    this.repoSubs = [
      repo.onDidChange(() => void this.reload(true)),
      repo.onDidChangeWorkingTree(() => void this.refreshStatus()),
    ];
    void this.reload();
  }

  async reveal(hash: string): Promise<void> {
    this.panel.reveal();
    this.post({ type: 'reveal', hash });
  }

  private post(m: HostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    const repo = this.repo;
    switch (m.type) {
      case 'ready':
        this.post({ type: 'config', config: readConfig() });
        this.post({ type: 'repos', repos: this.repos.map((r) => ({ path: r.root, label: r.label })), current: repo?.root ?? '' });
        await this.reload();
        return;
      case 'refresh':
        await this.reload();
        return;
      case 'fetch':
        if (!repo) return;
        this.post({ type: 'loading', loading: true });
        try { await repo.fetch(); } catch (e) { this.post({ type: 'error', message: (e as Error).message }); }
        await this.reload();
        return;
      case 'loadMore':
        await this.loadPage(false);
        return;
      case 'selectRepo': {
        const r = this.repos.find((x) => x.root === m.repo);
        if (r) this.switchRepo(r);
        return;
      }
      case 'select':
        if (!repo) return;
        if (m.hash === UNCOMMITTED) {
          this.post({ type: 'detail', detail: { hash: UNCOMMITTED, body: '', committer: '', committerDate: 0, files: this.statusFiles } });
          return;
        }
        try { this.post({ type: 'detail', detail: await repo.detail(m.hash) }); } catch (e) { this.post({ type: 'error', message: (e as Error).message }); }
        return;
      case 'openFile':
        if (repo) await this.openDiff(repo, m.hash, m.path, m.status, m.oldPath);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
      case 'operation':
        await vscode.commands.executeCommand('gitwave.operation', m.action);
        break;
      case 'worktree': {
        const wt = this.worktrees.find((w) => w.path === m.path);
        if (repo && wt) await this.actions.run(repo, wt, m.action);
        return;
      }
    }
  }

  private async openDiff(repo: Repository, hash: string, rel: string, status: string, oldPath?: string): Promise<void> {
    const working = vscode.Uri.file(path.join(repo.root, rel));
    if (hash === UNCOMMITTED) {
      if (status === '?' || status === 'A') { await vscode.commands.executeCommand('vscode.open', working, { preview: true }); return; }
      const head = GitFileProvider.uri(repo.root, 'HEAD', oldPath ?? rel);
      if (status === 'D') { await vscode.commands.executeCommand('vscode.open', head, { preview: true }); return; }
      await vscode.commands.executeCommand('vscode.diff', head, working, `${path.basename(rel)} (Working Tree)`, { preview: true });
      return;
    }
    const title = `${path.basename(rel)} (${hash.slice(0, 7)})`;
    const right = GitFileProvider.uri(repo.root, hash, rel);
    if (status === 'A') { await vscode.commands.executeCommand('vscode.open', right, { preview: true }); return; }
    const left = GitFileProvider.uri(repo.root, `${hash}^`, oldPath ?? rel);
    if (status === 'D') { await vscode.commands.executeCommand('vscode.open', left, { preview: true }); return; }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /**
   * Full reload: restart the layout and refetch, plus worktrees.
   * Keeps the current depth (how far the user has scrolled) so the list does not shrink back to
   * one page, and when `quiet` (background change) skips the spinner so the graph just repaints.
   */
  async reload(quiet = false): Promise<void> {
    this.layout = new GraphLayout(readConfig().colors.length);
    const keep = Math.min(this.loaded, MAX_RELOAD_DEPTH);
    this.loaded = 0;
    this.hasMore = false;
    await Promise.all([this.loadPage(true, { quiet, minCount: keep }), this.loadWorktrees()]);
  }

  /** Tell the webview about an in-progress merge/rebase/cherry-pick/revert (or that there is none). */
  private async postOperation(): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    const op = await repo.operationState().catch(() => undefined);
    if (repo === this.repo) this.post({ type: 'operation', op });
  }

  /** Re-check the working tree; reload the graph only if the uncommitted row would change. */
  private async refreshStatus(): Promise<void> {
    if (!this.repo) return;
    void this.postOperation(); // conflict counts change as files are resolved and staged
    try {
      const files = await this.repo.status();
      const before = this.statusFiles;
      const changed = files.length !== before.length || files.some((f, i) => f.path !== before[i]?.path || f.status !== before[i]?.status);
      if (!changed) return;
      if ((files.length === 0) !== (before.length === 0)) { await this.reload(true); return; }
      this.statusFiles = files;
      this.post({ type: 'status', files });
    } catch { /* ignore transient errors */ }
  }

  private async loadWorktrees(): Promise<void> {
    if (!this.repo) return;
    try {
      this.worktrees = await this.repo.worktrees();
      this.post({ type: 'worktrees', worktrees: this.worktrees.map((w) => ({ ...w, branch: shortBranch(w.branch), isCurrent: isCurrentWorktree(w.path) })) });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async loadPage(first: boolean, opts: { quiet?: boolean; minCount?: number } = {}): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    if (!first && (!this.hasMore || this.loading)) return;
    this.cts?.cancel();
    const cts = (this.cts = new vscode.CancellationTokenSource());
    const gen = ++this.generation;
    const cfg = vscode.workspace.getConfiguration('gitwave');
    this.loading = true;
    if (!opts.quiet) this.post({ type: 'loading', loading: true });
    try {
      if (first) {
        [this.stashes, this.statusFiles, this.tracking] = await Promise.all([repo.stashes(), repo.status(), repo.branchTracking().catch(() => new Map())]);
        void this.postOperation();
      }
      const { commits: raw, hasMore } = await repo.log({
        skip: this.loaded,
        maxCount: Math.max(cfg.get<number>('commitsPerPage', 500), opts.minCount ?? 0),
        remotes: cfg.get<boolean>('showRemoteBranches', true),
        tags: cfg.get<boolean>('showTags', true),
        extraRevs: this.stashes.map((s) => s.hash),
      }, cts.token);
      if (gen !== this.generation) return;
      const commits = this.decorate(foldStashes(raw, this.stashes));
      if (first && this.statusFiles.length > 0) {
        const head = await repo.headHash();
        if (gen !== this.generation) return;
        commits.unshift(this.uncommittedRow(head));
      }
      const rows = commits.map((c) => this.layout.add(c));
      this.loaded += raw.length;
      this.hasMore = hasMore;
      this.post({ type: 'commits', repo: repo.root, commits, rows, tail: hasMore ? this.layout.tail() : [], append: !first, hasMore, maxLanes: this.layout.maxLanes });
      if (readConfig().avatars) {
        const known = this.avatars.resolve(commits, await repo.avatarRemoteUrl(), (more) => { if (gen === this.generation) this.post({ type: 'avatars', avatars: more }); });
        this.post({ type: 'avatars', avatars: known });
      }
    } catch (e) {
      if (gen === this.generation && !cts.token.isCancellationRequested) this.post({ type: 'error', message: (e as Error).message });
    } finally {
      if (gen === this.generation) { this.loading = false; if (!opts.quiet) this.post({ type: 'loading', loading: false }); }
    }
  }

  /** Attach stash refs to their commits, and upstream tracking to local branches. */
  private decorate(commits: Commit[]): Commit[] {
    const byHash = new Map(this.stashes.map((s) => [s.hash, s]));
    for (const c of commits) {
      for (const r of c.refs) {
        if (r.kind === 'branch') { const t = this.tracking.get(r.name); if (t) r.tracking = t; }
      }
      const s = byHash.get(c.hash);
      if (s) c.refs = [{ kind: 'stash', name: `stash@{${s.index}}` }, ...c.refs];
    }
    return commits;
  }

  private uncommittedRow(head: string | undefined): Commit {
    const n = this.statusFiles.length;
    return {
      hash: UNCOMMITTED,
      parents: head ? [head] : [],
      author: '',
      email: '',
      date: Math.floor(Date.now() / 1000),
      subject: `Uncommitted changes (${n} file${n === 1 ? '' : 's'})`,
      refs: [],
    };
  }

  private html(): string {
    const w = this.panel.webview;
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.css'));
    const codicons = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'codicon.css'));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} https: data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>Git Wave</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.cts?.cancel();
    for (const s of this.repoSubs) s.dispose();
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export function readConfig(): GraphConfig {
  const c = vscode.workspace.getConfiguration('gitwave');
  return {
    laneWidth: c.get<number>('graph.laneWidth', 14),
    rowHeight: c.get<number>('graph.rowHeight', 24),
    colors: c.get<string[]>('graph.colors', []),
    dateFormat: c.get<'relative' | 'absolute' | 'iso'>('dateFormat', 'relative'),
    avatars: c.get<boolean>('avatars', true),
    visibleLanes: c.get<number>('graph.visibleLanes', 12),
  };
}
