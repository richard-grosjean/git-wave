import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from './git/repository';
import { shortBranch } from './git/worktree-parse';
import type { Worktree, WorktreeAction } from './shared/types';

function real(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** Whether `wtPath` is one of this window's workspace folders, i.e. the worktree that is open right now. */
export function isCurrentWorktree(wtPath: string): boolean {
  const target = real(wtPath);
  return (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file' && real(f.uri.fsPath) === target);
}

export type WorktreeSource =
  | { kind: 'branch'; name: string }
  | { kind: 'remote'; name: string }
  | { kind: 'commit'; hash: string };

interface AddPlan {
  title: string;
  dirSuffix: string;
  opts: { branch?: string; newBranch?: boolean; startPoint?: string; track?: boolean };
}

function askBranchName(prompt: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    validateInput: (v) => (/^[^\s~^:?*[\\]+$/.test(v) && !v.endsWith('.lock') ? undefined : 'Invalid branch name'),
  });
}

/** Shared implementation of worktree actions, used by both the tree view and the graph webview. */
export class WorktreeActions {
  constructor(private readonly onChanged: () => void) {}

  async run(repo: Repository, wt: Worktree, action: WorktreeAction): Promise<void> {
    try {
      if ((action === 'open' || action === 'openNewWindow') && isCurrentWorktree(wt.path)) {
        void vscode.window.showInformationMessage(`Git Wave: ${path.basename(wt.path)} is already open in this window.`);
        return;
      }
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

  /**
   * Creates a worktree and opens it in a new window. Without `from`, asks what to check out; from the graph's
   * context menus, `from` is the branch, remote branch or commit that was right-clicked.
   */
  async add(repo: Repository, from?: WorktreeSource): Promise<void> {
    try {
      const plan = from ? await this.planFrom(repo, from) : await this.pickPlan(repo);
      if (!plan) return;
      const parent = path.dirname(repo.root);
      const suggested = path.join(parent, `${path.basename(repo.root)}-${plan.dirSuffix.replace(/[\/\\]/g, '-')}`);
      const target = await vscode.window.showInputBox({
        title: plan.title,
        prompt: 'Worktree directory',
        value: suggested,
        valueSelection: [suggested.lastIndexOf(path.sep) + 1, suggested.length],
      });
      if (!target) return;
      await repo.worktreeAdd(target, plan.opts);
      this.onChanged();
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    } catch (e) {
      void vscode.window.showErrorMessage(`Git Wave: ${(e as Error).message}`);
    }
  }

  private async pickPlan(repo: Repository): Promise<AddPlan | undefined> {
    const [branches, worktrees] = await Promise.all([repo.branches(), repo.worktrees()]);
    const inUse = new Set(worktrees.map((w) => shortBranch(w.branch)).filter(Boolean));
    type Pick = vscode.QuickPickItem & { mode?: 'new' | 'existing' | 'detached'; branch?: string };
    const items: Pick[] = [
      { label: '$(add) Create new branch', mode: 'new' },
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
    if (!pick) return undefined;
    if (pick.mode === 'new') {
      const name = await askBranchName('New branch name');
      return name ? { title: `New branch ${name}`, dirSuffix: name, opts: { branch: name, newBranch: true } } : undefined;
    }
    if (pick.mode === 'existing' && pick.branch) return { title: `Branch ${pick.branch}`, dirSuffix: pick.branch, opts: { branch: pick.branch } };
    return { title: 'Detached at HEAD', dirSuffix: 'detached', opts: {} };
  }

  private async planFrom(repo: Repository, from: WorktreeSource): Promise<AddPlan | undefined> {
    if (from.kind === 'commit') {
      const short = from.hash.slice(0, 7);
      const pick = await vscode.window.showQuickPick(
        [{ label: '$(git-branch) New branch at this commit', detached: false }, { label: '$(git-commit) Detached at this commit', detached: true }],
        { title: `Create Worktree at ${short}` },
      );
      if (!pick) return undefined;
      if (pick.detached) return { title: `Detached at ${short}`, dirSuffix: short, opts: { startPoint: from.hash } };
      const name = await askBranchName(`New branch at ${short}`);
      return name ? { title: `New branch ${name} at ${short}`, dirSuffix: name, opts: { branch: name, newBranch: true, startPoint: from.hash } } : undefined;
    }
    let local = from.name;
    let remote: string | undefined;
    if (from.kind === 'remote') {
      const r = (await repo.remotes()).find((n) => from.name.startsWith(n + '/'));
      local = r ? from.name.slice(r.length + 1) : from.name.slice(from.name.indexOf('/') + 1);
      remote = from.name;
    }
    const [branches, worktrees] = await Promise.all([repo.branches(), repo.worktrees()]);
    const existing = worktrees.find((w) => shortBranch(w.branch) === local);
    if (existing) {
      const open = await vscode.window.showInformationMessage(
        `"${local}" already has a worktree at ${existing.path}.`,
        { modal: true, detail: 'Git does not allow a branch to be checked out in two worktrees at once.' },
        'Open in New Window',
      );
      if (open) await this.run(repo, existing, 'openNewWindow');
      return undefined;
    }
    if (branches.includes(local)) return { title: `Branch ${local}`, dirSuffix: local, opts: { branch: local } };
    return { title: `New branch ${local} tracking ${remote}`, dirSuffix: local, opts: { branch: local, newBranch: true, startPoint: remote, track: true } };
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
