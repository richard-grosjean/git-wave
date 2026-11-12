# Changelog

## Unreleased

- New right-click item on remote branches in the graph: **Delete Remote Branch…** (`git push <remote> --delete <branch>`, after a confirmation). If the branch is already gone on the remote, the stale remote-tracking ref is removed instead.

## 0.4.0 (2026-11-12)

- Branches now render as one segmented tag with what belongs to them: `branch | origin | worktree | this window`. Remote branches at the same commit as their local branch fold into it as a remote segment (they stay separate when they've diverged). Worktrees get their own icon (codicons bumped to 0.0.45) and are only shown when the repo has more than one. Each segment keeps its own right-click menu.
- Worktree actions moved to the right-click menu on the tag. The folder-icon badge and its click-to-open quick pick are gone.
- "Open" / "Open in New Window" are hidden for the worktree this window already has open (graph and Worktrees view), and say so instead of silently doing nothing. The Worktrees view marks it "● this window".
- New right-click items in the graph: **Create Worktree for Branch** (local branches without a worktree, and remote branches, which get a local tracking branch), **Create Worktree at Commit** (new branch or detached), and **Open Worktree in New Window / This Window** on branches that already have one.
- A newly created worktree opens in a new window straight away.
- Fix: "Unlock" no longer shows up for unlocked worktrees in the Worktrees view.

## 0.3.2 (2026-11-09)

- Fix: the graph now updates live again. Repos opened at their root resolved the git common dir to a non-existent `.git/.git`, so the ref/commit/worktree watcher never started and only the manual refresh picked up changes.

## 0.3.1 (2026-11-09)

- Worktrees checked out inside the repository (e.g. Claude Code's `.claude/worktrees/`) no longer appear as untracked files in the uncommitted row, and edits inside them no longer trigger status refreshes of the parent. Their commits, locks and removal still update the graph instantly.
- Background refreshes are seamless: when git changes refs or the working tree, the graph repaints in place, keeps your scroll depth, and no longer flashes the spinner.

## 0.3.0 (2026-11-09)

- Marketplace readiness: screenshot, CI, tag-triggered release workflow, release script.
- Fix: stash commits no longer show a stray `refs/stash` branch chip.

## 0.2.0

- Uncommitted changes row with working-tree diffs; refreshes as files change.
- Right-click menus on commits, branches, remotes, tags, stashes and worktree badges:
  checkout, branch, tag, merge, rebase, cherry-pick, revert, reset, rename, delete, stash ops, copy.
- Worktree-aware checkout: offers to open the worktree that already has the branch.
- Author avatars (GitHub via `gh` token or noreply address, else Gravatar, else initials).
- Stash commits shown as dashed nodes.
- Horizontally scrollable graph column for wide histories.
- Resizable Author and Date columns; Fetch button in the toolbar.
- Graph is drawn above row highlights; everything is named Git Wave.

## 0.1.0

- Initial scaffold: canvas graph with virtualized commit list, ref chips, commit details and diffs.
- Worktrees panel in the Source Control sidebar with lock state, lock reason, and prunable flag.
- Worktree actions: add, remove, lock, unlock, prune, open, copy path, reveal in graph.
- Worktree badges on the graph with a quick actions menu.
