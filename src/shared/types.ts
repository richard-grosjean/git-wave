// Types shared between the extension host and the webview. Keep this file free of
// imports from either side so it can be bundled into both.

export type RefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface Ref {
  kind: RefKind;
  /** Display name, e.g. `main`, `origin/main`, `v1.2.0`. */
  name: string;
  /** True for the branch HEAD points at, or for a detached HEAD pseudo-ref. */
  isHead?: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds (author date). */
  date: number;
  subject: string;
  refs: Ref[];
}

/** One strand drawn between row r-1 and row r. Lane indices are columns. */
export interface Edge {
  from: number;
  to: number;
  color: number;
}

/** Layout data for one commit row. `edges` describe the interval ABOVE this row. */
export interface Row {
  lane: number;
  color: number;
  edges: Edge[];
}

export interface Worktree {
  path: string;
  head: string;
  /** Full ref name, e.g. refs/heads/main. Absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  isMain: boolean;
  locked: boolean;
  lockReason?: string;
  prunable?: string;
}

export interface CommitFile {
  status: string;
  path: string;
  oldPath?: string;
}

export interface CommitDetail {
  hash: string;
  body: string;
  committer: string;
  committerDate: number;
  files: CommitFile[];
}

export interface GraphConfig {
  laneWidth: number;
  rowHeight: number;
  colors: string[];
  dateFormat: 'relative' | 'absolute' | 'iso';
}

// ---- Messages: host -> webview ----
export type HostMessage =
  | { type: 'config'; config: GraphConfig }
  | { type: 'repos'; repos: { path: string; label: string }[]; current: string }
  | { type: 'commits'; repo: string; commits: Commit[]; rows: Row[]; tail: Edge[]; append: boolean; hasMore: boolean; maxLanes: number }
  | { type: 'worktrees'; worktrees: Worktree[] }
  | { type: 'detail'; detail: CommitDetail }
  | { type: 'loading'; loading: boolean }
  | { type: 'reveal'; hash: string }
  | { type: 'error'; message: string };

// ---- Messages: webview -> host ----
export type WorktreeAction = 'open' | 'openNewWindow' | 'lock' | 'unlock' | 'remove' | 'copyPath';

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'loadMore' }
  | { type: 'selectRepo'; repo: string }
  | { type: 'select'; hash: string }
  | { type: 'openFile'; hash: string; path: string; status: string; oldPath?: string }
  | { type: 'copy'; text: string }
  | { type: 'worktree'; path: string; action: WorktreeAction }
  | { type: 'worktreeMenu'; path: string };
