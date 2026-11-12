import * as vscode from 'vscode';
import { GitError } from './git/exec';
import type { Repository } from './git/repository';
import type { OperationAction } from './shared/types';
import { pullRequestUrl } from './git/remote-url';
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
  /** On local branch chips: the configured upstream, e.g. `origin/main`. */
  upstream?: string;
  /** The upstream is configured and still exists. */
  hasUpstream?: boolean;
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

  async deleteRemoteBranch(remoteBranch: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const split = await repo.splitRemoteRef(remoteBranch);
    if (!split) { void vscode.window.showErrorMessage(`Git Wave: no remote found for "${remoteBranch}".`); return; }
    const { remote, branch } = split;
    if (branch === 'HEAD') { void vscode.window.showErrorMessage(`Git Wave: "${remoteBranch}" is the remote's default-branch pointer and can't be deleted.`); return; }
    const ok = await vscode.window.showWarningMessage(
      `Delete branch "${branch}" on remote "${remote}"?`,
      { modal: true, detail: `This runs "git push ${remote} --delete ${branch}" and removes the branch for everyone using ${remote}.` },
      'Delete Remote Branch',
    );
    if (!ok) return;
    await this.guard(`Delete ${remoteBranch}`, async (r) => {
      try { await r.deleteRemoteBranch(remote, branch); }
      catch (e) {
        // Already gone on the remote: just drop the stale tracking ref so the chip disappears.
        if (/remote ref does not exist/i.test(String(e))) await r.deleteRemoteTrackingRef(remoteBranch);
        else throw e;
      }
    });
  }

  // ---------- remotes ----------

  /** The only remote, or the user's pick (origin first). Undefined when there are none or the pick is cancelled. */
  private async pickRemote(repo: Repository, title: string): Promise<string | undefined> {
    const remotes = await repo.remotes();
    if (remotes.length === 0) { void vscode.window.showErrorMessage('Git Wave: this repository has no remotes.'); return undefined; }
    if (remotes.length === 1) return remotes[0];
    return vscode.window.showQuickPick([...remotes].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b))), { title });
  }

  /** Pushes a local branch to its upstream, or to a chosen remote with `-u` when it has none. Offers a force push when rejected. */
  async pushBranch(name: string, upstream: string | undefined): Promise<boolean> {
    const repo = this.repoFor();
    if (!repo) return false;
    let target = upstream ? await repo.splitRemoteRef(upstream) : undefined;
    const setUpstream = !target;
    if (!target) {
      const remote = await this.pickRemote(repo, `Push ${name} to`);
      if (!remote) return false;
      target = { remote, branch: name };
    }
    const { remote, branch } = target;
    let ok = false;
    await this.guard(`Push ${name}`, async (r) => {
      try { await r.push(name, remote, branch, { setUpstream }); ok = true; }
      catch (e) {
        if (!/rejected|non-fast-forward|fetch first/i.test(String(e))) throw e;
        const force = await vscode.window.showWarningMessage(
          `Push rejected: ${remote}/${branch} has commits that "${name}" doesn't.`,
          { modal: true, detail: 'Pull first to keep them, or force push to replace the remote branch with yours (--force-with-lease: refuses if the remote changed since your last fetch).' },
          'Force Push',
        );
        if (force) { await r.push(name, remote, branch, { setUpstream, force: true }); ok = true; }
      }
    });
    return ok;
  }

  /**
   * Brings a branch up to date with its upstream: `git pull` when it's checked out here or in another worktree,
   * otherwise a fast-forward of the branch ref.
   */
  async pullBranch(c: GraphContext): Promise<void> {
    const repo = this.repoFor();
    if (!repo || !c.name) return;
    if (!c.upstream) { void vscode.window.showInformationMessage(`Git Wave: "${c.name}" has no upstream. Use Set Upstream first.`); return; }
    if (c.isHead) { await this.guard(`Pull ${c.name}`, (r) => r.pull()); return; }
    if (c.worktreePath) { const wt = c.worktreePath; await this.guard(`Pull ${c.name}`, (r) => r.pull(wt)); return; }
    const split = await repo.splitRemoteRef(c.upstream);
    if (!split) { void vscode.window.showErrorMessage(`Git Wave: "${c.upstream}" isn't a remote branch.`); return; }
    await this.guard(`Pull ${c.name}`, async (r) => {
      try { await r.fastForward(c.name!, split.remote, split.branch); }
      catch (e) {
        if (!/non-fast-forward|rejected/i.test(String(e))) throw e;
        void vscode.window.showWarningMessage(`Git Wave: "${c.name}" and ${c.upstream} have diverged, so it can't be fast-forwarded. Check it out and pull to merge or rebase.`);
      }
    });
  }

  async setUpstream(name: string, current: string | undefined): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const remoteBranches = await repo.remoteBranches();
    type Pick = vscode.QuickPickItem & { upstream?: string };
    const items: Pick[] = remoteBranches.map((rb) => ({ label: rb, upstream: rb, description: rb === current ? 'current' : undefined }));
    // Matching name first, then the rest.
    items.sort((a, b) => Number(b.label.endsWith(`/${name}`)) - Number(a.label.endsWith(`/${name}`)));
    if (current) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: '$(close) Unset Upstream', description: current });
    const pick = await vscode.window.showQuickPick<Pick>(items, { title: `Upstream for ${name}`, placeHolder: remoteBranches.length ? 'Remote branch to track' : 'No remote branches. Fetch or push first.' });
    if (!pick) return;
    await this.guard(`Set upstream of ${name}`, (r) => r.setUpstream(name, pick.upstream));
  }

  /** Opens the host's "new pull request" page for a local branch (pushing it first if needed) or a remote branch. */
  async createPullRequest(c: GraphContext): Promise<void> {
    const repo = this.repoFor();
    if (!repo || !c.name) return;
    let ref = c.webviewSection === 'remote' ? c.name : c.hasUpstream ? c.upstream : undefined;
    if (!ref) {
      const ok = await vscode.window.showInformationMessage(`"${c.name}" isn't on a remote yet.`, { modal: true, detail: 'Push it (and set its upstream) before opening a pull request?' }, 'Push');
      if (!ok || !(await this.pushBranch(c.name, undefined))) return;
      ref = (await repo.branchTracking()).get(c.name)?.upstream;
      if (!ref) return;
    }
    const split = await repo.splitRemoteRef(ref);
    if (!split) { void vscode.window.showErrorMessage(`Git Wave: no remote found for "${ref}".`); return; }
    const url = pullRequestUrl(await repo.remoteUrl(split.remote), split.branch);
    if (!url) { void vscode.window.showErrorMessage(`Git Wave: don't know how to open a pull request for remote "${split.remote}" (GitHub, GitLab and Bitbucket are supported).`); return; }
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
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

  async deleteRemoteTag(name: string): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const remote = await this.pickRemote(repo, `Delete tag ${name} from`);
    if (!remote) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete tag "${name}" on remote "${remote}"?`,
      { modal: true, detail: `This runs "git push ${remote} --delete refs/tags/${name}" and removes the tag for everyone using ${remote}. Your local tag is kept.` },
      'Delete Remote Tag',
    );
    if (!ok) return;
    await this.guard(`Delete tag ${name} on ${remote}`, async (r) => {
      try { await r.deleteRemoteTag(remote, name); }
      catch (e) {
        if (/remote ref does not exist/i.test(String(e))) void vscode.window.showInformationMessage(`Git Wave: tag "${name}" isn't on ${remote}.`);
        else throw e;
      }
    });
  }

  // ---------- working tree ----------

  async stashChanges(): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)', placeHolder: 'WIP' });
    if (message === undefined) return;
    const hasUntracked = (await repo.status()).some((f) => f.status === '?');
    let includeUntracked = false;
    if (hasUntracked) {
      const pick = await vscode.window.showQuickPick(['Include untracked files', 'Tracked changes only'], { title: 'Stash' });
      if (!pick) return;
      includeUntracked = pick === 'Include untracked files';
    }
    await this.guard('Stash changes', (r) => r.stashPush(message.trim() || undefined, includeUntracked));
  }

  async discardChanges(): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    const files = await repo.status();
    const untracked = files.filter((f) => f.status === '?').length;
    const tracked = files.length - untracked;
    const options = [tracked ? 'Discard Changes' : '', untracked ? (tracked ? 'Discard Including Untracked' : 'Delete Untracked Files') : ''].filter(Boolean);
    if (!options.length) return;
    const pick = await vscode.window.showWarningMessage(
      'Discard uncommitted changes? This cannot be undone.',
      { modal: true, detail: [tracked ? `${tracked} changed file(s) will be reset to HEAD.` : '', untracked ? `${untracked} untracked file(s) ${tracked ? 'are kept unless you choose "Discard Including Untracked"' : 'will be deleted'}.` : ''].filter(Boolean).join('\n') },
      ...options,
    );
    if (!pick) return;
    await this.guard('Discard changes', (r) => r.discardChanges(pick !== 'Discard Changes'));
  }

  // ---------- merge / rebase / cherry-pick / revert in progress ----------

  async operation(action: OperationAction): Promise<void> {
    const repo = this.repoFor();
    if (!repo) return;
    if (action === 'scm') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
    const op = await repo.operationState();
    if (!op) { this.refresh(); return; }
    const name = op.kind === 'cherry-pick' ? 'Cherry-pick' : op.kind[0]!.toUpperCase() + op.kind.slice(1);
    if (action === 'continue' && op.conflicts > 0) {
      const pick = await vscode.window.showWarningMessage(
        `${op.conflicts} file(s) still have conflicts.`,
        { modal: true, detail: 'Resolve them and stage the result (e.g. "Complete Merge" in the merge editor, or Stage in Source Control), then continue.' },
        'Open Source Control',
      );
      if (pick) await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }
    if (action === 'abort') {
      const ok = await vscode.window.showWarningMessage(
        `Abort the ${op.kind}?`,
        { modal: true, detail: op.kind === 'rebase' ? `${op.branch ?? 'The branch'} goes back to where it was before the rebase. Conflict resolutions so far are lost.` : 'The working tree goes back to where it was before. Conflict resolutions so far are lost.' },
        `Abort ${name}`,
      );
      if (!ok) return;
    }
    await this.guard(`${name} --${action}`, (r) => r.operation(op.kind, action));
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
