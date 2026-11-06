# Changelog

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
