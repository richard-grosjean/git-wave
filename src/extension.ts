import * as vscode from 'vscode';
import { GitFileProvider, SCHEME } from './fileProvider';
import { setGitPath } from './git/exec';
import { discoverRepositories, Repository } from './git/repository';
import { AvatarService } from './avatars';
import { CommitActions, type GraphContext } from './commitCommands';
import { GraphPanel } from './panel';
import { WorktreeActions } from './worktreeCommands';
import { WorktreeItem, WorktreeProvider } from './worktreeView';

let repos: Repository[] = [];

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  setGitPath(vscode.workspace.getConfiguration('git').get<string>('path'));

  const worktreeProvider = new WorktreeProvider();
  const actions = new WorktreeActions(() => worktreeProvider.refresh());
  const avatars = new AvatarService(ctx.globalState);
  const commitActions = new CommitActions(() => GraphPanel.current?.repository ?? repos[0], () => { void GraphPanel.current?.reload(); worktreeProvider.refresh(); });
  ctx.subscriptions.push(
    worktreeProvider,
    vscode.window.createTreeView('gitwave.worktrees', { treeDataProvider: worktreeProvider, showCollapseAll: false }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitFileProvider((root) => repos.find((r) => r.root === root))),
  );

  const refreshRepos = async () => {
    for (const r of repos) r.dispose();
    repos = await discoverRepositories();
    worktreeProvider.setRepositories(repos);
    await vscode.commands.executeCommand('setContext', 'gitwave.hasRepo', repos.length > 0);
    GraphPanel.current?.setRepositories(repos);
  };
  await refreshRepos();
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshRepos()));

  /** Repository for a tree item, the active editor's folder, or the first one. */
  const pickRepo = (item?: WorktreeItem): Repository | undefined => {
    if (item instanceof WorktreeItem) return item.repo;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const folder = vscode.workspace.getWorkspaceFolder(active);
      if (folder) {
        const match = repos.find((r) => active.fsPath.startsWith(r.root));
        if (match) return match;
      }
    }
    return repos[0];
  };

  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('gitwave.open', (item?: WorktreeItem) => {
    if (repos.length === 0) { void vscode.window.showInformationMessage('Git Wave: no Git repository in this workspace.'); return; }
    GraphPanel.show(ctx, repos, actions, avatars, pickRepo(item));
  });
  reg('gitwave.refresh', () => { void GraphPanel.current?.reload(); worktreeProvider.refresh(); });
  reg('gitwave.worktrees.refresh', () => worktreeProvider.refresh());
  reg('gitwave.worktree.add', async (item?: WorktreeItem) => { const r = pickRepo(item); if (r) await actions.add(r); });
  reg('gitwave.worktree.prune', async (item?: WorktreeItem) => { const r = pickRepo(item); if (r) await actions.prune(r); });
  for (const action of ['lock', 'unlock', 'remove', 'open', 'openNewWindow', 'copyPath'] as const) {
    reg(`gitwave.worktree.${action}`, async (item?: WorktreeItem) => {
      if (!(item instanceof WorktreeItem)) return;
      await actions.run(item.repo, item.worktree, action);
    });
  }
  reg('gitwave.worktree.revealInGraph', async (item?: WorktreeItem) => {
    if (!(item instanceof WorktreeItem)) return;
    const panel = GraphPanel.show(ctx, repos, actions, avatars, item.repo);
    await panel.reveal(item.worktree.head);
  });

  // ---- graph context menu commands (receive the data-vscode-context object) ----
  const label = (c: GraphContext) => c.name ?? c.hash?.slice(0, 7) ?? '';
  reg('gitwave.fetch', async () => {
    const repo = GraphPanel.current?.repository ?? pickRepo();
    if (!repo) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Git Wave: Fetching' }, () => repo.fetch());
    } catch (e) { void vscode.window.showErrorMessage(`Git Wave: ${(e as Error).message}`); }
    void GraphPanel.current?.reload();
    worktreeProvider.refresh();
  });
  reg('gitwave.commit.checkout', (c: GraphContext) => c.hash && commitActions.checkoutCommit(c.hash));
  reg('gitwave.commit.createBranch', (c: GraphContext) => c.hash && commitActions.createBranch(c.hash, c.hash.slice(0, 7)));
  reg('gitwave.commit.createTag', (c: GraphContext) => c.hash && commitActions.createTag(c.hash));
  reg('gitwave.commit.cherryPick', (c: GraphContext) => c.hash && commitActions.cherryPick(c.hash));
  reg('gitwave.commit.revert', (c: GraphContext) => c.hash && commitActions.revert(c.hash));
  reg('gitwave.commit.merge', (c: GraphContext) => (c.name ?? c.hash) && commitActions.merge(c.name ?? c.hash!));
  reg('gitwave.commit.reset', (c: GraphContext) => c.hash && commitActions.reset(c.hash));
  reg('gitwave.commit.copyHash', (c: GraphContext) => c.hash && vscode.env.clipboard.writeText(c.hash));
  reg('gitwave.commit.copySubject', (c: GraphContext) => c.subject && vscode.env.clipboard.writeText(c.subject));
  reg('gitwave.branch.checkout', (c: GraphContext) => c.name && (c.webviewSection === 'remote' ? commitActions.checkoutRemote(c.name) : commitActions.checkoutBranch(c.name)));
  reg('gitwave.branch.merge', (c: GraphContext) => c.name && commitActions.merge(c.name));
  reg('gitwave.branch.rebase', (c: GraphContext) => c.name && commitActions.rebase(c.name));
  reg('gitwave.branch.createFrom', (c: GraphContext) => c.name && commitActions.createBranch(c.name, label(c)));
  reg('gitwave.branch.rename', (c: GraphContext) => c.name && commitActions.renameBranch(c.name));
  reg('gitwave.branch.delete', (c: GraphContext) => c.name && commitActions.deleteBranch(c.name));
  reg('gitwave.branch.copyName', (c: GraphContext) => c.name && vscode.env.clipboard.writeText(c.name));
  reg('gitwave.tag.checkout', (c: GraphContext) => c.name && commitActions.checkoutCommit(c.name));
  reg('gitwave.tag.delete', (c: GraphContext) => c.name && commitActions.deleteTag(c.name));
  reg('gitwave.tag.copyName', (c: GraphContext) => c.name && vscode.env.clipboard.writeText(c.name));
  for (const op of ['apply', 'pop', 'drop'] as const) {
    reg(`gitwave.stash.${op}`, (c: GraphContext) => c.stashIndex !== undefined && commitActions.stash(c.stashIndex, op));
  }
  for (const action of ['open', 'openNewWindow', 'lock', 'unlock', 'remove', 'copyPath'] as const) {
    reg(`gitwave.ctx.worktree.${action}`, async (c: GraphContext) => {
      const repo = GraphPanel.current?.repository;
      if (!repo || !c.path) return;
      const wt = (await repo.worktrees()).find((w) => w.path === c.path);
      if (wt) await actions.run(repo, wt, action);
    });
  }
}

export function deactivate(): void {
  for (const r of repos) r.dispose();
  repos = [];
}
