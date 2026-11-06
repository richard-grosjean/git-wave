import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitFileProvider } from './fileProvider';
import type { Repository } from './git/repository';
import { shortBranch } from './git/worktree-parse';
import { GraphLayout } from './graph/layout';
import type { GraphConfig, HostMessage, WebviewMessage, Worktree } from './shared/types';
import type { WorktreeActions } from './worktreeCommands';

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
  private repoSub: vscode.Disposable | undefined;

  static show(ctx: vscode.ExtensionContext, repos: Repository[], actions: WorktreeActions, preferred?: Repository): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      GraphPanel.current.setRepositories(repos, preferred);
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('gitwave.graph', 'Git Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    panel.iconPath = new vscode.ThemeIcon('git-branch');
    GraphPanel.current = new GraphPanel(ctx, panel, repos, actions, preferred);
    return GraphPanel.current;
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    private repos: Repository[],
    private readonly actions: WorktreeActions,
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

  setRepositories(repos: Repository[], preferred?: Repository): void {
    this.repos = repos;
    const next = preferred ?? (this.repo && repos.includes(this.repo) ? this.repo : repos[0]);
    this.post({ type: 'repos', repos: repos.map((r) => ({ path: r.root, label: r.label })), current: next?.root ?? '' });
    if (next && next !== this.repo) this.switchRepo(next);
  }

  private switchRepo(repo: Repository): void {
    this.repoSub?.dispose();
    this.repo = repo;
    this.repoSub = repo.onDidChange(() => void this.reload());
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
        try { this.post({ type: 'detail', detail: await repo.detail(m.hash) }); } catch (e) { this.post({ type: 'error', message: (e as Error).message }); }
        return;
      case 'openFile':
        if (repo) await this.openDiff(repo, m.hash, m.path, m.status, m.oldPath);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        return;
      case 'worktree': {
        const wt = this.worktrees.find((w) => w.path === m.path);
        if (repo && wt) await this.actions.run(repo, wt, m.action);
        return;
      }
      case 'worktreeMenu': {
        const wt = this.worktrees.find((w) => w.path === m.path);
        if (repo && wt) await this.actions.menu(repo, wt);
        return;
      }
    }
  }

  private async openDiff(repo: Repository, hash: string, rel: string, status: string, oldPath?: string): Promise<void> {
    const title = `${path.basename(rel)} (${hash.slice(0, 7)})`;
    const right = GitFileProvider.uri(repo.root, hash, rel);
    if (status === 'A') {
      await vscode.commands.executeCommand('vscode.open', right, { preview: true });
      return;
    }
    const left = GitFileProvider.uri(repo.root, `${hash}^`, oldPath ?? rel);
    if (status === 'D') {
      await vscode.commands.executeCommand('vscode.open', left, { preview: true });
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /** Full reload: restart the layout and fetch the first page plus worktrees. */
  async reload(): Promise<void> {
    this.layout = new GraphLayout(readConfig().colors.length);
    this.loaded = 0;
    this.hasMore = false;
    await Promise.all([this.loadPage(true), this.loadWorktrees()]);
  }

  private async loadWorktrees(): Promise<void> {
    if (!this.repo) return;
    try {
      this.worktrees = await this.repo.worktrees();
      this.post({ type: 'worktrees', worktrees: this.worktrees.map((w) => ({ ...w, branch: shortBranch(w.branch) })) });
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async loadPage(first: boolean): Promise<void> {
    const repo = this.repo;
    if (!repo) return;
    if (!first && (!this.hasMore || this.loading)) return;
    this.cts?.cancel();
    const cts = (this.cts = new vscode.CancellationTokenSource());
    const gen = ++this.generation;
    const cfg = vscode.workspace.getConfiguration('gitwave');
    this.loading = true;
    this.post({ type: 'loading', loading: true });
    try {
      const { commits, hasMore } = await repo.log({
        skip: this.loaded,
        maxCount: cfg.get<number>('commitsPerPage', 500),
        remotes: cfg.get<boolean>('showRemoteBranches', true),
        tags: cfg.get<boolean>('showTags', true),
      }, cts.token);
      if (gen !== this.generation) return;
      const rows = commits.map((c) => this.layout.add(c));
      this.loaded += commits.length;
      this.hasMore = hasMore;
      this.post({ type: 'commits', repo: repo.root, commits, rows, tail: hasMore ? this.layout.tail() : [], append: !first, hasMore, maxLanes: this.layout.maxLanes });
    } catch (e) {
      if (gen === this.generation && !cts.token.isCancellationRequested) this.post({ type: 'error', message: (e as Error).message });
    } finally {
      if (gen === this.generation) { this.loading = false; this.post({ type: 'loading', loading: false }); }
    }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; font-src ${w.cspSource}; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>Git Graph</title>
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
    this.repoSub?.dispose();
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
  };
}
