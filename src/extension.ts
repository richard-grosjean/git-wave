import * as vscode from 'vscode';
import { GitFileProvider, SCHEME } from './fileProvider';
import { setGitPath } from './git/exec';
import { discoverRepositories, Repository } from './git/repository';
import { GraphPanel } from './panel';
import { WorktreeActions } from './worktreeCommands';
import { WorktreeItem, WorktreeProvider } from './worktreeView';

let repos: Repository[] = [];

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  setGitPath(vscode.workspace.getConfiguration('git').get<string>('path'));

  const worktreeProvider = new WorktreeProvider();
  const actions = new WorktreeActions(() => worktreeProvider.refresh());
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
    GraphPanel.show(ctx, repos, actions, pickRepo(item));
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
    const panel = GraphPanel.show(ctx, repos, actions, item.repo);
    await panel.reveal(item.worktree.head);
  });
}

export function deactivate(): void {
  for (const r of repos) r.dispose();
  repos = [];
}
