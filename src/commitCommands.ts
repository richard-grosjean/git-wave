import * as vscode from 'vscode';
import { GitError } from './git/exec';
import type { Repository } from './git/repository';
import { shortBranch } from './git/worktree-parse';

/** Context object VS Code passes from `data-vscode-context` on right-click in the webview. */
export interface GraphContext {
  webviewSection?: 'commit' | 'branch' | 'remote' | 'tag' | 'stash' | 'worktree' | 'uncommitted';
  hash?: string;
  name?: string;
  isHead?: boolean;
  stashIndex?: number;
  subject?: string;
  path?: string;
  /** On branch chips: the worktree that has this branch checked out, if any. */
  worktreePath?: string;
  worktreeIsCurrent?: boolean;
}

/** Actions on commits, branches, tags and stashes, invoked from the graph's context menus. */
export class CommitActions {
  constructor(private readonly repoFor: () => Repository | undefined, private readonly refresh: () => void) {}

  private async guard(label: string, fn: (repo: Repository) => Promise<unknown>): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Git Wave: ${label}` }, () => fn(repo));
    } catch (e) {
      const msg = e instanceof GitError ? e.message : String(e);
      if (/conflict|CONFLICT|fix conflicts|needs merge/i.test(msg)) {
        const pick = await vscode.window.showWarningMessage(`${label}: conflicts need resolving.`, { detail: msg }, 'Open Source Control');
        if (pick) await vscode.commands.executeCommand('workbench.view.scm');
      } else {
        void vscode.window.showErrorMessage(`Git Wave: ${msg}`);
      }
    } finally {
      this.refresh();
    }
  }

  // ---------- checkout ----------

  /** Checks out a local branch, offering to open its worktree if it is checked out elsewhere. */
  async checkoutBranch(name: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const worktrees = await repo.worktrees().catch(() => []);
    const elsewhere = worktrees.find((w) => shortBranch(w.branch) === name && w.path !== repo.root);
    if (elsewhere) {
      const pick = await vscode.window.showInformationMessage(
        `"${name}" is already checked out in the worktree at ${elsewhere.path}.`,
        { modal: true, detail: 'Git does not allow a branch to be checked out in two worktrees at once.' },
        'Open That Worktree', 'Open in New Window',
      );
      if (pick === 'Open That Worktree') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(elsewhere.path), { forceNewWindow: false });
      else if (pick === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(elsewhere.path), { forceNewWindow: true });
      return;
    }
    await this.guard(`Checkout ${name}`, (r) => r.checkout(name));
  }

  async checkoutRemote(remoteBranch: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const local = remoteBranch.slice(remoteBranch.indexOf('/') + 1);
    const locals = await repo.branches();
    if (locals.includes(local)) { await this.checkoutBranch(local); return; }
    await this.guard(`Checkout ${remoteBranch}`, (r) => r.checkoutTracking(remoteBranch));
  }

  async checkoutCommit(hash: string): Promise<void> {
    await this.guard(`Checkout ${hash.slice(0, 7)}`, (r) => r.checkout(hash));
  }

  // ---------- branches ----------

  async createBranch(at: string, atLabel: string): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: `New branch at ${atLabel}`, validateInput: validateRefName });
    if (!name) return;
    const checkout = await vscode.window.showQuickPick(['Create and checkout', 'Create only'], { title: `Branch "${name}"` });
    if (!checkout) return;
    await this.guard(`Create branch ${name}`, (r) => r.createBranch(name, at, checkout === 'Create and checkout'));
  }

  async deleteBranch(name: string): Promise<void> {
    const pick = await vscode.window.showWarningMessage(`Delete branch "${name}"?`, { modal: true }, 'Delete', 'Force Delete');
    if (!pick) return;
    await this.guard(`Delete branch ${name}`, async (r) => {
      try { await r.deleteBranch(name, pick === 'Force Delete'); }
      catch (e) {
        if (pick === 'Delete' && /not fully merged/i.test(String(e))) {
          const force = await vscode.window.showWarningMessage(`"${name}" is not fully merged.`, { modal: true }, 'Force Delete');
          if (force) await r.deleteBranch(name, true);
        } else throw e;
      }
    });
  }

  async renameBranch(name: string): Promise<void> {
    const to = await vscode.window.showInputBox({ prompt: `Rename branch "${name}" to`, value: name, validateInput: validateRefName });
    if (!to || to === name) return;
    await this.guard(`Rename ${name}`, (r) => r.renameBranch(name, to));
  }

  // ---------- integrate ----------

  async merge(ref: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const current = (await repo.currentBranch()) ?? 'HEAD';
    type Pick = vscode.QuickPickItem & { mode: 'default' | 'no-ff' | 'squash' | 'ff-only' };
    const pick = await vscode.window.showQuickPick<Pick>([
      { label: 'Merge', description: 'fast-forward if possible', mode: 'default' },
      { label: 'Merge with merge commit', description: '--no-ff', mode: 'no-ff' },
      { label: 'Squash merge', description: '--squash, leaves changes staged', mode: 'squash' },
      { label: 'Fast-forward only', description: '--ff-only', mode: 'ff-only' },
    ], { title: `Merge ${ref} into ${current}` });
    if (!pick) return;
    await this.guard(`Merge ${ref}`, (r) => r.merge(ref, pick.mode));
  }

  async rebase(onto: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const current = (await repo.currentBranch()) ?? 'HEAD';
    const ok = await vscode.window.showWarningMessage(`Rebase ${current} onto ${onto}?`, { modal: true }, 'Rebase');
    if (!ok) return;
    await this.guard(`Rebase onto ${onto}`, (r) => r.rebase(onto));
  }

  async cherryPick(hash: string): Promise<void> {
    const pick = await vscode.window.showQuickPick(['Cherry-pick and commit', 'Cherry-pick without committing'], { title: `Cherry-pick ${hash.slice(0, 7)}` });
    if (!pick) return;
    await this.guard(`Cherry-pick ${hash.slice(0, 7)}`, (r) => r.cherryPick(hash, pick.endsWith('committing')));
  }

  async revert(hash: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(`Revert ${hash.slice(0, 7)}? A new commit undoing it will be created.`, { modal: true }, 'Revert');
    if (!ok) return;
    await this.guard(`Revert ${hash.slice(0, 7)}`, (r) => r.revert(hash));
  }

  async reset(hash: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const current = (await repo.currentBranch()) ?? 'HEAD';
    type Pick = vscode.QuickPickItem & { mode: 'soft' | 'mixed' | 'hard' };
    const pick = await vscode.window.showQuickPick<Pick>([
      { label: 'Soft', description: 'keep all changes staged', mode: 'soft' },
      { label: 'Mixed', description: 'keep changes in the working tree', mode: 'mixed' },
      { label: 'Hard', description: 'discard all changes', mode: 'hard' },
    ], { title: `Reset ${current} to ${hash.slice(0, 7)}` });
    if (!pick) return;
    if (pick.mode === 'hard') {
      const ok = await vscode.window.showWarningMessage('Hard reset discards uncommitted changes. Continue?', { modal: true }, 'Reset');
      if (!ok) return;
    }
    await this.guard(`Reset to ${hash.slice(0, 7)}`, (r) => r.reset(hash, pick.mode));
  }

  // ---------- tags ----------

  async createTag(at: string): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: `New tag at ${at.slice(0, 7)}`, validateInput: validateRefName });
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Tag message (leave empty for a lightweight tag)' });
    if (message === undefined) return;
    await this.guard(`Create tag ${name}`, (r) => r.createTag(name, at, message.trim() || undefined));
  }

  async deleteTag(name: string): Promise<void> {
    const ok = await vscode.window.showWarningMessage(`Delete tag "${name}"?`, { modal: true }, 'Delete');
    if (!ok) return;
    await this.guard(`Delete tag ${name}`, (r) => r.deleteTag(name));
  }

  // ---------- stashes ----------

  async stash(index: number, op: 'apply' | 'pop' | 'drop'): Promise<void> {
    if (op === 'drop') {
      const ok = await vscode.window.showWarningMessage(`Drop stash@{${index}}?`, { modal: true }, 'Drop');
      if (!ok) return;
    }
    await this.guard(`${op} stash@{${index}}`, (r) => (op === 'apply' ? r.stashApply(index) : op === 'pop' ? r.stashPop(index) : r.stashDrop(index)));
  }
}

function validateRefName(v: string): string | undefined {
  if (!v.trim()) return 'Name is required';
  if (/[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\.lock$|^@$/.test(v)) return 'Invalid ref name';
  return undefined;
}
