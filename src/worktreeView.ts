import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Repository } from './git/repository';
import { shortBranch } from './git/worktree-parse';
import type { Worktree } from './shared/types';

export class WorktreeItem extends vscode.TreeItem {
  constructor(readonly repo: Repository, readonly worktree: Worktree) {
    super(labelFor(worktree), vscode.TreeItemCollapsibleState.None);
    const wt = worktree;
    this.description = tildify(wt.path);
    this.contextValue = ['worktree', wt.isMain ? 'main' : 'linked', wt.locked ? 'locked' : 'unlocked', wt.prunable ? 'prunable' : ''].filter(Boolean).join(':');
    this.iconPath = new vscode.ThemeIcon(
      wt.prunable ? 'warning' : wt.locked ? 'lock' : wt.isMain ? 'root-folder' : 'folder',
      wt.prunable ? new vscode.ThemeColor('list.warningForeground') : wt.locked ? new vscode.ThemeColor('list.highlightForeground') : undefined,
    );
    this.resourceUri = vscode.Uri.file(wt.path);
    this.tooltip = tooltipFor(wt);
    this.command = { command: 'gitwave.worktree.revealInGraph', title: 'Reveal in Git Wave', arguments: [this] };
  }
}

function labelFor(wt: Worktree): string {
  if (wt.bare) return '(bare)';
  if (wt.detached || !wt.branch) return `(detached) ${wt.head.slice(0, 7)}`;
  return shortBranch(wt.branch) ?? wt.branch;
}

function tooltipFor(wt: Worktree): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${labelFor(wt)}**${wt.isMain ? ' $(root-folder) main worktree' : ''}\n\n`);
  md.appendMarkdown(`$(folder) \`${wt.path}\`\n\n`);
  md.appendMarkdown(`$(git-commit) \`${wt.head.slice(0, 12)}\`\n\n`);
  if (wt.locked) md.appendMarkdown(`$(lock) **Locked**${wt.lockReason ? `: ${wt.lockReason}` : ''}\n\n`);
  if (wt.prunable) md.appendMarkdown(`$(warning) Prunable: ${wt.prunable}\n\n`);
  return md;
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

export class WorktreeProvider implements vscode.TreeDataProvider<WorktreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private repos: Repository[] = [];
  private subs: vscode.Disposable[] = [];
  private cache = new Map<Repository, Worktree[]>();

  setRepositories(repos: Repository[]): void {
    for (const s of this.subs) s.dispose();
    this.repos = repos;
    this.subs = repos.map((r) => r.onDidChange(() => this.refresh()));
    this.refresh();
  }

  refresh(): void {
    this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(el: WorktreeItem): vscode.TreeItem {
    return el;
  }

  async getChildren(el?: WorktreeItem): Promise<WorktreeItem[]> {
    if (el) return [];
    const items: WorktreeItem[] = [];
    for (const repo of this.repos) {
      let wts = this.cache.get(repo);
      if (!wts) {
        try { wts = await repo.worktrees(); } catch { wts = []; }
        this.cache.set(repo, wts);
      }
      for (const wt of wts) items.push(new WorktreeItem(repo, wt));
    }
    return items;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
