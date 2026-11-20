# Changelog

## Unreleased

- New merge option, **Merge without committing** (`--no-ff --no-commit`): the merge is staged but not committed, so you can look through what changed first. Press **Continue** in the banner to commit, or **Abort** to drop it.
- The Merge picker now orders its options by your git config. With `merge.ff=false`, **Merge without committing** comes first, then **Merge with merge commit**. With `merge.ff=only`, **Fast-forward only** comes first. Otherwise a plain merge (fast-forward if possible) comes first. To always put one option first, set the new `gitwave.defaultMergeMode` setting (default `auto`).
- Branch highlighting is hover-only. Clicking a branch, remote or tag no longer pins the highlight. It selects the row like any other click.

## 0.7.0 (2026-11-18)

- Click a branch, remote or tag to highlight its history: its commits and the lines leading to them stay bright, everything else dims. Hover a tag for a quick preview. Click it again, press Esc or use the ✕ in the toolbar to clear.
- The separate "open in this window" tag is gone. The worktree segment of a branch tag is now filled with the branch colour when it's the worktree open in this window, and hollow otherwise.
- Fixed your avatar sometimes going blank on a new commit right after the "Uncommitted changes" row.
- Fixed the graph showing only a few rows and then blank space after switching back to its tab.

## 0.6.2 (2026-11-17)

- The worktree open in this window now has its own "open in this window" tag next to its branch, with an icon and your theme's badge colour, instead of a faint grey "this window" segment.
- Right-clicking a commit outlines its row while the menu is open, so you can see what the menu applies to. It no longer selects the commit and opens the detail pane.

## 0.6.1 (2026-11-16)

- Requires VS Code 1.123 or later. The extension is now built for the Node 24 runtime that VS Code ships from 1.123.
- Build tooling: TypeScript 7, esbuild 0.28, vsce 4; release workflow on Node 26 with current GitHub Actions.

## 0.6.0 (2026-11-16)

- The fetch button shows how long ago the repo was last fetched (`5m`, `3h`, `2d`), including fetches from VS Code's autofetch or the terminal, and turns amber after an hour. Hover for the exact time.
- Right-click a commit or branch to open it in the browser or copy its link (GitHub, GitLab and Bitbucket). Commit links use a remote that already has the commit, and warn if it isn't pushed yet.
- Larger, easier-to-read commit list: text is 2px above VS Code's UI font and rows are taller (default row height 32), with more room around ref tags. New `gitwave.graph.fontSize` setting.
- The toolbar refresh button is gone, since the graph updates itself. "Git Wave: Refresh Graph" is still in the command palette.

## 0.5.2 (2026-11-13)

- 

## 0.5.1 (2026-11-13)

- Fix: branches no longer drop out of the graph after a fetch, push or checkout. Overlapping background refreshes could reset the graph to its first page, hiding branches whose tips were further down until you scrolled again.
- Fix: a `git remote` read that was still running when `.git/config` changed could cache the old remote list, so a new or renamed remote's branches showed as local branches.

## 0.5.0 (2026-11-13)

- New right-click items on branches: **Push Branch** (sets the upstream on first push; if the push is rejected, offers a `--force-with-lease` push), **Pull Branch** (pulls when the branch is checked out here or in another worktree, otherwise fast-forwards it), **Set Upstream…** and **Create Pull Request…** (opens the host's new-PR page for GitHub, GitLab or Bitbucket; pushes the branch first if it isn't on a remote yet). Create Pull Request is also on remote branches.
- Branch tags show ahead/behind counts against their upstream (`↑2 ↓1`, `⊘` when the upstream is gone). Hover for details.
- **Delete Remote Branch…** on remote branches (`git push <remote> --delete <branch>`, after a confirmation). If the branch is already gone on the remote, the stale remote-tracking ref is removed instead.
- **Delete Tag from Remote…** on tags, after a confirmation. The local tag is kept.
- Right-click the uncommitted changes row to **Stash Changes…** (optional message, optionally including untracked files) or **Discard Changes…** (tracked only, or including untracked files).
- Fix: git no longer waits forever on a username/password prompt it can't show. Fetch and push now fail straight away with a hint to set up a credential helper or SSH key.
- A merge, rebase, cherry-pick or revert that stops part-way now shows a banner above the graph: what's in progress (with rebase progress, e.g. `3/7`), how many files are still conflicted, and **Continue**, **Skip**, **Abort** and **Source Control** buttons. Continue keeps git's prepared commit message instead of opening an editor; Abort asks first.
- Fix: adding or renaming a remote while VS Code is open no longer makes its branches show up as local branches. Remotes are re-read when `.git/config` changes.
- Fix: remote names containing `/` (e.g. `team/origin`) now split correctly, so their branches join the matching local branch tag.
- Fix: GitHub avatars work when the GitHub remote isn't called `origin`. The first GitHub remote is used.

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
