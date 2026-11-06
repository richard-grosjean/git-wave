import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from './git/repository';
import { shortBranch } from './git/worktree-parse';
import type { Worktree, WorktreeAction } from './shared/types';

/** Shared implementation of worktree actions, used by both the tree view and the graph webview. */
export class WorktreeActions {
  constructor(private readonly onChanged: () => void) {}

  async run(repo: Repository, wt: Worktree, action: WorktreeAction): Promise<void> {
    try {
      switch (action) {
        case 'open':
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: false });
          return;
        case 'openNewWindow':
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
          return;
        case 'copyPath':
          await vscode.env.clipboard.writeText(wt.path);
          return;
        case 'lock': {
          if (wt.isMain) { void vscode.window.showWarningMessage('The main worktree cannot be locked.'); return; }
          const reason = await vscode.window.showInputBox({ prompt: `Lock reason for ${path.basename(wt.path)} (optional)`, placeHolder: 'e.g. on removable drive, long-running build…' });
          if (reason === undefined) return;
          await repo.worktreeLock(wt.path, reason.trim() || undefined);
          break;
        }
        case 'unlock':
          await repo.worktreeUnlock(wt.path);
          break;
        case 'remove': {
          if (wt.isMain) { void vscode.window.showWarningMessage('The main worktree cannot be removed.'); return; }
          const label = shortBranch(wt.branch) ?? wt.head.slice(0, 7);
          const choice = await vscode.window.showWarningMessage(
            `Remove worktree "${label}" at ${wt.path}?${wt.locked ? ' It is locked; removing requires force.' : ''}`,
            { modal: true, detail: 'The directory will be deleted. The branch itself is kept.' },
            'Remove', 'Force Remove',
          );
          if (!choice) return;
          try {
            await repo.worktreeRemove(wt.path, choice === 'Force Remove' || wt.locked);
          } catch (e) {
            const msg = (e as Error).message;
            if (/contains modified or untracked files|use --force/i.test(msg)) {
              const force = await vscode.window.showWarningMessage('Worktree has uncommitted changes.', { modal: true, detail: msg }, 'Force Remove');
              if (force !== 'Force Remove') return;
              await repo.worktreeRemove(wt.path, true);
            } else throw e;
          }
          break;
        }
      }
      this.onChanged();
    } catch (e) {
      void vscode.window.showErrorMessage(`Git Wave: ${(e as Error).message}`);
    }
  }

  /** Quick-pick menu for a worktree, used from the graph where there is no native context menu. */
  async menu(repo: Repository, wt: Worktree): Promise<void> {
    type Item = vscode.QuickPickItem & { action: WorktreeAction };
    const items: Item[] = [
      { label: '$(empty-window) Open in New Window', action: 'openNewWindow' },
      { label: '$(folder-opened) Open in Current Window', action: 'open' },
    ];
    if (!wt.isMain) {
      items.push(wt.locked
        ? { label: '$(unlock) Unlock', description: wt.lockReason, action: 'unlock' }
        : { label: '$(lock) Lock…', action: 'lock' });
    }
    items.push({ label: '$(copy) Copy Path', action: 'copyPath' });
    if (!wt.isMain) items.push({ label: '$(trash) Remove…', action: 'remove' });
    const pick = await vscode.window.showQuickPick(items, { title: `Worktree: ${shortBranch(wt.branch) ?? wt.head.slice(0, 7)}  ·  ${wt.path}` });
    if (pick) await this.run(repo, wt, pick.action);
  }

  async add(repo: Repository): Promise<void> {
    try {
      const [branches, worktrees] = await Promise.all([repo.branches(), repo.worktrees()]);
      const inUse = new Set(worktrees.map((w) => shortBranch(w.branch)).filter(Boolean));
      type Pick = vscode.QuickPickItem & { mode?: 'new' | 'existing' | 'detached'; branch?: string };
      const items: Pick[] = [
        { label: '$(add) Create new branch…', mode: 'new' },
        { label: '$(git-commit) Detached at HEAD', mode: 'detached' },
        { label: 'Existing branches', kind: vscode.QuickPickItemKind.Separator },
        ...branches.map<Pick>((b) => ({
          label: `$(git-branch) ${b}`,
          description: inUse.has(b) ? 'checked out in another worktree' : undefined,
          mode: 'existing',
          branch: b,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, { title: 'Add Worktree: choose what to check out', matchOnDescription: true });
      if (!pick) return;
      let branch: string | undefined;
      let newBranch = false;
      if (pick.mode === 'new') {
        branch = await vscode.window.showInputBox({
          prompt: 'New branch name',
          validateInput: (v) => (/^[^\s~^:?*[\\]+$/.test(v) && !v.endsWith('.lock') ? undefined : 'Invalid branch name'),
        });
        if (!branch) return;
        newBranch = true;
      } else if (pick.mode === 'existing') {
        branch = pick.branch;
      }
      const parent = path.dirname(repo.root);
      const suggested = path.join(parent, `${path.basename(repo.root)}-${(branch ?? 'detached').replace(/[\/\\]/g, '-')}`);
      const target = await vscode.window.showInputBox({
        prompt: 'Worktree directory',
        value: suggested,
        valueSelection: [suggested.lastIndexOf(path.sep) + 1, suggested.length],
      });
      if (!target) return;
      await repo.worktreeAdd(target, branch, newBranch);
      this.onChanged();
      const open = await vscode.window.showInformationMessage(`Worktree created at ${target}`, 'Open in New Window', 'Open Here');
      if (open) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: open === 'Open in New Window' });
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Git Wave: ${(e as Error).message}`);
    }
  }

  async prune(repo: Repository): Promise<void> {
    try {
      const wts = await repo.worktrees();
      const prunable = wts.filter((w) => w.prunable);
      if (prunable.length === 0) { void vscode.window.showInformationMessage('No prunable worktrees.'); return; }
      const ok = await vscode.window.showWarningMessage(`Prune ${prunable.length} stale worktree entr${prunable.length === 1 ? 'y' : 'ies'}?`, { modal: true, detail: prunable.map((w) => `${w.path}\n  ${w.prunable}`).join('\n') }, 'Prune');
      if (ok !== 'Prune') return;
      await repo.worktreePrune();
      this.onChanged();
    } catch (e) {
      void vscode.window.showErrorMessage(`Git Wave: ${(e as Error).message}`);
    }
  }
}
