import { UNCOMMITTED, type Commit, type CommitDetail, type CommitFile, type Edge, type GraphConfig, type HostMessage, type OperationAction, type OperationState, type Ref, type Row, type WebviewMessage, type Worktree } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);

interface PersistedState { colAuthor?: number; colDate?: number; detailH?: number; filesW?: number }
const persisted: PersistedState = (vscode.getState() as PersistedState | undefined) ?? {};
const persist = () => vscode.setState(persisted);

// ---------- state ----------
let config: GraphConfig = { laneWidth: 14, rowHeight: 32, fontSize: 0, colors: ['#4e9bff'], dateFormat: 'relative', avatars: true, visibleLanes: 12 };
let commits: Commit[] = [];
let rows: Row[] = [];
let tail: Edge[] = [];
let maxLanes = 1;
let hasMore = false;
let loading = false;
let worktrees: Worktree[] = [];
let worktreesByHead = new Map<string, Worktree[]>();
let worktreesByBranch = new Map<string, Worktree>();
let indexByHash = new Map<string, number>();
let avatars = new Map<string, string>();
const avatarFailed = new Set<string>();
let selected: string | null = null;
/** Row outlined while its context menu is open. */
let contextHash: string | null = null;
let pendingReveal: string | null = null;
let revealAttempts = 0;
let headHash: string | null = null;
/** Commit of the hovered ref chip, whose history is highlighted. */
let hoverTip: string | null = null;
/** Highlighted ancestry: commits reachable from the tip, plus which edges of each row lead into them. */
let lit: { tip: string; commits: Commit[]; n: number; set: Set<string>; edges: Uint8Array[]; tail: Uint8Array } | null = null;
let graphX = 0; // horizontal scroll offset of the graph column, in px
let currentRepo = '';

// ---------- DOM ----------
const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="toolbar">
    <select id="repo" title="Repository"></select>
    <input id="filter" type="search" placeholder="Filter by message, author, hash or ref…" spellcheck="false">
    <span id="count"></span>
    <span id="spinner" class="codicon codicon-loading codicon-modifier-spin" hidden></span>
    <button id="fetch" class="icon-btn" title="Fetch all remotes"><span class="codicon codicon-cloud-download"></span><span id="fetch-age"></span></button>
  </div>
  <div id="opbar" hidden>
    <span class="codicon codicon-warning"></span><span id="op-text"></span>
    <span class="op-actions">
      <button data-op="continue" class="op-btn primary">Continue</button>
      <button data-op="skip" class="op-btn">Skip</button>
      <button data-op="abort" class="op-btn">Abort</button>
      <button data-op="scm" class="op-btn" title="Resolve conflicts in Source Control">Source Control</button>
    </span>
  </div>
  <div id="header">
    <div class="c-graph">Graph</div><div class="c-desc">Description</div>
    <div class="c-author">Author<span class="resize" data-col="colAuthor"></span></div>
    <div class="c-date">Date<span class="resize" data-col="colDate"></span></div>
    <div class="c-hash">Commit</div>
  </div>
  <div id="scroller" tabindex="0">
    <div id="spacer"></div>
    <div id="rows"></div>
    <canvas id="graph"></canvas>
    <div id="hscroll" hidden><div id="hspacer"></div></div>
    <div id="empty" hidden>No commits.</div>
  </div>
  <div id="detail" hidden>
    <div id="detail-resize" class="split-h" title="Drag to resize"></div>
    <div id="detail-head">
      <div id="detail-title">
        <span id="detail-subject"></span>
        <span id="detail-hash" class="mono" title="Click to copy"></span>
        <button id="detail-close" class="icon-btn" title="Close (Esc)"><span class="codicon codicon-close"></span></button>
      </div>
      <div id="detail-meta"></div>
    </div>
    <div id="detail-main">
      <div id="detail-side">
        <pre id="detail-body"></pre>
        <div id="detail-files"></div>
      </div>
      <div id="detail-split" class="split-v" title="Drag to resize"></div>
      <div id="diff-pane">
        <div id="diff-head">
          <span id="diff-path" class="mono"></span>
          <span id="diff-stats" class="mono"></span>
          <button id="diff-open" class="icon-btn" title="Open in diff editor"><span class="codicon codicon-go-to-file"></span></button>
        </div>
        <div id="diff"></div>
      </div>
    </div>
  </div>
  <div id="error" hidden></div>
`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $<HTMLDivElement>('scroller');
const spacer = $('spacer');
const canvas = $<HTMLCanvasElement>('graph');
const rowsEl = $('rows');
const hscroll = $('hscroll');
const hspacer = $('hspacer');
const repoSel = $<HTMLSelectElement>('repo');
const filterEl = $<HTMLInputElement>('filter');
const detailEl = $('detail');
const ctx2d = canvas.getContext('2d')!;

let view: number[] = [];
let filterText = '';

const PAD = 8;
function graphVisibleWidth(): number {
  return Math.max(3, Math.min(maxLanes, config.visibleLanes)) * config.laneWidth + PAD * 2;
}
function graphFullWidth(): number {
  return Math.max(3, maxLanes) * config.laneWidth + PAD * 2;
}

function applyCss(): void {
  const root = document.documentElement.style;
  root.setProperty('--row-h', `${config.rowHeight}px`);
  root.setProperty('--row-font', config.fontSize > 0 ? `${config.fontSize}px` : 'calc(var(--vscode-font-size) + 2px)');
  root.setProperty('--graph-w', `${graphVisibleWidth()}px`);
  root.setProperty('--col-author', `${persisted.colAuthor ?? 170}px`);
  root.setProperty('--col-date', `${persisted.colDate ?? 130}px`);
  root.setProperty('--detail-h', persisted.detailH ? `${persisted.detailH}px` : '50vh');
  root.setProperty('--files-w', `${persisted.filesW ?? 320}px`);
  const scrollable = graphFullWidth() > graphVisibleWidth();
  hscroll.hidden = !scrollable;
  hspacer.style.width = `${graphFullWidth()}px`;
  if (!scrollable) graphX = 0;
}

function rebuildView(): void {
  const q = filterText.trim().toLowerCase();
  if (!q) {
    view = commits.map((_, i) => i);
  } else {
    view = [];
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i]!;
      if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.hash.startsWith(q) || c.refs.some((r) => r.name.toLowerCase().includes(q))) view.push(i);
    }
  }
  spacer.style.height = `${view.length * config.rowHeight + (hasMore ? config.rowHeight : 0)}px`;
  $('empty').hidden = view.length > 0 || loading;
  const real = commits.length - (commits[0]?.hash === UNCOMMITTED ? 1 : 0);
  $('count').textContent = q ? `${view.length} / ${real}` : `${real}${hasMore ? '+' : ''}`;
  render();
}

// ---------- rendering ----------
const pool: HTMLDivElement[] = [];
let raf = 0;
function scheduleRender(): void {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function render(): void {
  const rowH = config.rowHeight;
  const top = scroller.scrollTop;
  const height = scroller.clientHeight;
  // While the panel is in the background the scroller can measure as collapsed; rendering then
  // would leave only a few rows drawn. Skip it; the visibility/focus/resize hooks re-render on return.
  if (height === 0 || document.hidden) return;
  const first = Math.max(0, Math.floor(top / rowH) - 4);
  const last = Math.min(view.length - 1, Math.ceil((top + height) / rowH) + 4);
  const filtered = filterText.trim().length > 0;
  computeLit();

  let used = 0;
  for (let v = first; v <= last; v++) {
    const i = view[v]!;
    const c = commits[i]!;
    let el = pool[used];
    if (!el) { el = createRowEl(); pool.push(el); rowsEl.appendChild(el); }
    used++;
    el.hidden = false;
    el.style.transform = `translateY(${v * rowH}px)`;
    el.dataset.hash = c.hash;
    el.classList.toggle('selected', c.hash === selected);
    el.classList.toggle('context', c.hash === contextHash);
    el.classList.toggle('head', c.hash === headHash);
    el.classList.toggle('uncommitted', c.hash === UNCOMMITTED);
    el.classList.toggle('dim', !!lit && !lit.set.has(c.hash));
    fillRow(el, c, rows[i]!);
  }
  for (let k = used; k < pool.length; k++) pool[k]!.hidden = true;

  canvas.hidden = filtered;
  hscroll.hidden = filtered || graphFullWidth() <= graphVisibleWidth();
  if (!filtered) drawGraph(first, last, top, height);
  if (hasMore && !loading && last >= view.length - 60) post({ type: 'loadMore' });
}

function createRowEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<div class="c-graph"></div><div class="c-desc"><span class="refs"></span><span class="subject"></span></div><div class="c-author"><span class="avatar"></span><span class="name"></span></div><div class="c-date"></div><div class="c-hash mono"></div>';
  return el;
}

function fillRow(el: HTMLDivElement, c: Commit, row: Row): void {
  const desc = el.children[1] as HTMLElement;
  const refs = desc.children[0] as HTMLElement;
  const subject = desc.children[1] as HTMLElement;
  const authorCell = el.children[2] as HTMLElement;
  const avatarEl = authorCell.children[0] as HTMLElement;
  const nameEl = authorCell.children[1] as HTMLElement;
  const dateEl = el.children[3] as HTMLElement;
  const hashEl = el.children[4] as HTMLElement;
  const color = config.colors[row.color % config.colors.length] ?? '#888';
  subject.textContent = c.subject;
  if (c.hash === UNCOMMITTED) {
    refs.replaceChildren();
    el.dataset.vscodeContext = JSON.stringify({ webviewSection: 'uncommitted', preventDefaultContextMenuItems: true });
    avatarEl.replaceChildren();
    avatarEl.className = 'avatar';
    delete avatarEl.dataset.key;
    nameEl.textContent = '';
    dateEl.textContent = '';
    dateEl.title = '';
    hashEl.textContent = '';
    return;
  }
  refs.replaceChildren(...refChips(c, color));
  el.dataset.vscodeContext = JSON.stringify({ webviewSection: 'commit', hash: c.hash, subject: c.subject, preventDefaultContextMenuItems: true });
  renderAvatar(avatarEl, c);
  nameEl.textContent = c.author;
  authorCell.title = `${c.author} <${c.email}>`;
  dateEl.textContent = formatDate(c.date);
  dateEl.title = new Date(c.date * 1000).toLocaleString();
  hashEl.textContent = c.hash.slice(0, 8);
}

function renderAvatar(el: HTMLElement, c: Commit): void {
  if (!config.avatars) { el.className = 'avatar'; el.replaceChildren(); delete el.dataset.key; return; }
  const url = avatars.get(c.email.toLowerCase());
  const key = `${url ?? ''}|${c.author}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (url && !avatarFailed.has(url)) {
    const img = document.createElement('img');
    img.src = url; img.alt = ''; img.loading = 'lazy'; img.draggable = false;
    img.onerror = () => { avatarFailed.add(url); el.dataset.key = ''; renderAvatar(el, c); };
    el.className = 'avatar';
    el.replaceChildren(img);
  } else {
    el.className = 'avatar initials';
    el.style.setProperty('--hue', `${hashHue(c.email || c.author)}`);
    el.textContent = initials(c.author);
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Splits `origin/feat/x` into remote `origin` and branch `feat/x`, using the remote the host matched. */
function splitRemote(r: Ref): { remote: string; branch: string } {
  if (r.remote && r.name.startsWith(`${r.remote}/`)) return { remote: r.remote, branch: r.name.slice(r.remote.length + 1) };
  const i = r.name.indexOf('/');
  return i < 0 ? { remote: r.name, branch: '' } : { remote: r.name.slice(0, i), branch: r.name.slice(i + 1) };
}

/**
 * Ref chips for a commit. A local branch, the remote branches pointing at the same commit with the same name,
 * and the branch's worktree are joined into one segmented tag (`branch | origin | worktree`). Each segment keeps its
 * own right-click menu. The worktree segment is filled when it's the one open in this window, hollow otherwise.
 */
function refChips(c: Commit, color: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const locals = new Set(c.refs.filter((r) => r.kind === 'branch').map((r) => r.name));
  const joinedRemotes = new Set(c.refs.filter((r) => r.kind === 'remote' && locals.has(splitRemote(r).branch)).map((r) => r.name));
  const shownWorktrees = new Set<string>();
  for (const r of c.refs) {
    if (joinedRemotes.has(r.name)) continue;
    const chip = refChip(c, r, color);
    if (r.kind !== 'branch') { out.push(chip); continue; }
    const segments = [chip];
    for (const rr of c.refs) {
      if (rr.kind === 'remote' && joinedRemotes.has(rr.name) && splitRemote(rr).branch === r.name) {
        segments.push(refChip(c, rr, color, splitRemote(rr).remote));
      }
    }
    const wt = worktreesByBranch.get(r.name);
    if (wt) {
      const ctx = JSON.parse(chip.dataset.vscodeContext!);
      chip.dataset.vscodeContext = JSON.stringify({ ...ctx, worktreePath: wt.path, worktreeIsCurrent: !!wt.isCurrent });
      shownWorktrees.add(wt.path);
      segments.push(...worktreeSegments(wt, color));
    }
    const g = group(segments);
    if (r.isHead) g.classList.add('is-head');
    out.push(g);
  }
  // Worktrees not attached to a branch chip (detached HEADs).
  for (const wt of worktreesByHead.get(c.hash) ?? []) {
    const segs = shownWorktrees.has(wt.path) ? [] : worktreeSegments(wt, color);
    if (segs.length) out.push(group(segs));
  }
  return out;
}

function group(segments: HTMLElement[]): HTMLElement {
  if (segments.length === 1) return segments[0]!;
  const g = document.createElement('span');
  g.className = 'ref-group';
  g.append(...segments);
  return g;
}

function refChip(c: Commit, r: Commit['refs'][number], color: string, label = r.name): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `chip ${r.kind}${r.isHead ? ' is-head' : ''}`;
  chip.style.setProperty('--chip', color);
  const icon = r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : r.kind === 'stash' ? 'archive' : 'git-branch';
  chip.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
  chip.append(label);
  const ctx: Record<string, unknown> = { webviewSection: r.kind === 'head' ? 'commit' : r.kind, name: r.name, hash: c.hash, isHead: !!r.isHead, preventDefaultContextMenuItems: true };
  if (r.kind === 'stash') {
    const m = /\{(\d+)\}/.exec(r.name);
    ctx.stashIndex = m ? Number(m[1]) : 0;
  }
  chip.title = r.kind === 'remote' ? `Remote branch ${r.name}` : r.kind === 'tag' ? `Tag ${r.name}` : r.kind === 'stash' ? `Stash ${r.name}` : `Branch ${r.name}${r.isHead ? ' (HEAD)' : ''}`;
  const t = r.kind === 'branch' ? r.tracking : undefined;
  if (t?.upstream) {
    ctx.upstream = t.upstream;
    ctx.hasUpstream = !t.gone;
    chip.title += t.gone ? `\nUpstream ${t.upstream} is gone` : `\nTracks ${t.upstream}${trackSummary(t)}`;
    const marks = [t.ahead ? `↑${t.ahead}` : '', t.behind ? `↓${t.behind}` : '', t.gone ? '⊘' : ''].filter(Boolean).join(' ');
    if (marks) {
      const m = document.createElement('span');
      m.className = 'track';
      m.textContent = marks;
      chip.append(m);
    }
  }
  chip.dataset.vscodeContext = JSON.stringify(ctx);
  chip.dataset.tip = c.hash;
  return chip;
}

function renderOperation(op: OperationState | undefined): void {
  const bar = $('opbar');
  bar.hidden = !op;
  if (!op) return;
  const what = op.kind === 'rebase'
    ? `Rebasing${op.branch ? ` ${op.branch}` : ''}${op.step && op.total ? ` (${op.step}/${op.total})` : ''}`
    : `${op.kind === 'cherry-pick' ? 'Cherry-pick' : op.kind[0]!.toUpperCase() + op.kind.slice(1)} in progress`;
  $('op-text').textContent = `${what}: ${op.conflicts ? `${op.conflicts} conflicted file${op.conflicts === 1 ? '' : 's'}` : 'conflicts resolved, ready to continue'}`;
  bar.classList.toggle('resolved', op.conflicts === 0);
  // Merges can't skip a commit.
  bar.querySelector<HTMLElement>('[data-op="skip"]')!.hidden = op.kind === 'merge';
}

function trackSummary(t: { ahead?: number; behind?: number }): string {
  const parts = [t.ahead ? `${t.ahead} ahead` : '', t.behind ? `${t.behind} behind` : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : ' (up to date)';
}

function worktreeContext(wt: Worktree): string {
  return JSON.stringify({ webviewSection: 'worktree', path: wt.path, locked: wt.locked, isMain: wt.isMain, isCurrent: !!wt.isCurrent, preventDefaultContextMenuItems: true });
}

function worktreeTitle(wt: Worktree): string {
  return [
    `${wt.isMain ? 'Main worktree' : 'Worktree'}: ${wt.path}`,
    wt.isCurrent ? 'Open in this window' : '',
    wt.locked ? `Locked${wt.lockReason ? ': ' + wt.lockReason : ''}` : '',
    'Right-click for worktree actions',
  ].filter(Boolean).join('\n');
}

/**
 * Worktree segment: `worktree-name`, filled when it's open in this window and hollow otherwise. Omitted when the repo has a single worktree (unless detached), where it would
 * only repeat the obvious.
 */
function worktreeSegments(wt: Worktree, color: string): HTMLElement[] {
  if (worktrees.length <= 1 && !wt.detached) return [];
  const tag = document.createElement('span');
  tag.className = `chip wt${wt.isCurrent ? ' is-current' : ''}${wt.locked ? ' locked' : ''}`;
  tag.style.setProperty('--chip', color);
  tag.innerHTML = '<span class="codicon codicon-worktree"></span>';
  tag.append(wt.detached ? `${basename(wt.path)} (detached)` : basename(wt.path));
  if (wt.locked) tag.insertAdjacentHTML('beforeend', '<span class="codicon codicon-lock lock"></span>');
  tag.title = worktreeTitle(wt);
  tag.dataset.vscodeContext = worktreeContext(wt);
  return [tag];
}

function drawGraph(first: number, last: number, top: number, height: number): void {
  const dpr = window.devicePixelRatio || 1;
  const rowH = config.rowHeight;
  const laneW = config.laneWidth;
  const width = graphVisibleWidth();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  canvas.style.transform = `translateY(${top}px)`;
  const g = ctx2d;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  g.lineWidth = 2;
  g.lineCap = 'round';
  const x = (lane: number) => PAD + lane * laneW + laneW / 2 - graphX;
  const y = (r: number) => r * rowH + rowH / 2 - top;
  const colorOf = (c: number) => config.colors[c % config.colors.length] ?? '#888';
  const n = view.length;
  const rFirst = Math.max(0, first);
  const rLast = Math.min(n - 1, last + 1);
  const hasUncommitted = commits[0]?.hash === UNCOMMITTED;

  // Paths keyed by colour, and by whether they're dimmed (outside a highlighted branch's history).
  const DIM = 0.2;
  const keyed = (m: Map<string, Path2D>, c: number, dim: boolean) => { const k = `${c}|${dim ? 1 : 0}`; let p = m.get(k); if (!p) { p = new Path2D(); m.set(k, p); } return p; };
  const solid = new Map<string, Path2D>();
  const dashed = new Map<string, Path2D>();
  for (let r = rFirst; r <= rLast; r++) {
    const row = rows[r]!;
    const y0 = y(r - 1), y1 = y(r);
    row.edges.forEach((e, k) => {
      // The strand leaving the uncommitted row is dashed until it reaches HEAD.
      const fromUncommitted = hasUncommitted && e.from === rows[0]!.lane && r <= (indexByHash.get(headHash ?? '') ?? -1) && e.color === rows[0]!.color;
      const dim = !!lit && !lit.edges[r]![k];
      addEdge(keyed(fromUncommitted ? dashed : solid, e.color, dim), x(e.from), y0, x(e.to), y1);
    });
  }
  if (hasMore && last >= n - 2 && n > 0) {
    const y0 = y(n - 1), y1 = y0 + rowH * 0.6;
    tail.forEach((e, k) => addEdge(keyed(solid, e.color, !!lit && !lit.tail[k]), x(e.from), y0, x(e.to), y1));
  }
  const stroke = (m: Map<string, Path2D>) => {
    for (const [k, p] of m) {
      const [c, dim] = k.split('|');
      g.globalAlpha = dim === '1' ? DIM : 1;
      g.strokeStyle = colorOf(Number(c));
      g.stroke(p);
    }
    g.globalAlpha = 1;
  };
  stroke(solid);
  if (dashed.size) {
    g.setLineDash([3, 3]);
    stroke(dashed);
    g.setLineDash([]);
  }

  const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
  for (let r = rFirst; r <= Math.min(n - 1, last); r++) {
    const row = rows[view[r]!]!;
    const c = commits[view[r]!]!;
    const cx = x(row.lane), cy = y(r);
    if (cx < -8 || cx > width + 8) continue;
    const col = colorOf(row.color);
    g.globalAlpha = lit && !lit.set.has(c.hash) ? DIM : 1;
    g.beginPath();
    if (c.hash === UNCOMMITTED) {
      g.arc(cx, cy, 4, 0, Math.PI * 2);
      g.setLineDash([2, 2]); g.strokeStyle = col; g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); g.lineWidth = 2;
    } else if (c.hash === headHash) {
      g.arc(cx, cy, 5.5, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
      g.beginPath(); g.arc(cx, cy, 2.5, 0, Math.PI * 2); g.fillStyle = bg; g.fill();
    } else if (c.parents.length > 1) {
      g.arc(cx, cy, 4, 0, Math.PI * 2);
      g.fillStyle = bg; g.fill();
      g.strokeStyle = col; g.lineWidth = 2; g.stroke();
    } else {
      g.arc(cx, cy, 3.5, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
    }
    if (c.hash === selected) {
      g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2);
      g.strokeStyle = col; g.lineWidth = 1; g.globalAlpha *= 0.5; g.stroke(); g.lineWidth = 2;
    }
  }
  g.globalAlpha = 1;
  // Fade hint when more lanes are hidden to the right.
  if (graphFullWidth() - graphX > width + 1) {
    const grad = g.createLinearGradient(width - 14, 0, width, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, bg);
    g.fillStyle = grad;
    g.fillRect(width - 14, 0, 14, height);
  }
}

// ---------- branch highlight ----------
function highlightTip(): string | null {
  return hoverTip;
}

/**
 * Works out which commits and edges belong to the highlighted tip's history (its ancestors among the loaded
 * commits). Walking down the rows, a lane is lit below a row if it carries the row's own lit commit or a lit strand
 * passing through; an edge is lit if it leaves a lit lane. Cached until the tip or the loaded commits change.
 */
function computeLit(): void {
  const tip = highlightTip();
  if (!tip || !indexByHash.has(tip)) { lit = null; return; }
  if (lit && lit.tip === tip && lit.commits === commits && lit.n === commits.length) return;
  const set = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const h = stack.pop()!;
    if (set.has(h)) continue;
    const i = indexByHash.get(h);
    if (i === undefined) continue;
    set.add(h);
    for (const p of commits[i]!.parents) if (!set.has(p)) stack.push(p);
  }
  // The uncommitted changes sit on top of HEAD.
  if (tip === headHash && commits[0]?.hash === UNCOMMITTED) set.add(UNCOMMITTED);
  const edges: Uint8Array[] = new Array(rows.length);
  let below = new Set<number>();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const flags = new Uint8Array(row.edges.length);
    const next = new Set<number>();
    row.edges.forEach((e, k) => {
      if (!below.has(e.from)) return;
      flags[k] = 1;
      if (e.to !== row.lane) next.add(e.to); // a strand passing this row; one ending here lights nothing further
    });
    if (set.has(commits[r]!.hash)) next.add(row.lane);
    edges[r] = flags;
    below = next;
  }
  const tailFlags = new Uint8Array(tail.length);
  tail.forEach((e, k) => { if (below.has(e.from)) tailFlags[k] = 1; });
  lit = { tip, commits, n: commits.length, set, edges, tail: tailFlags };
}

let hoverTimer = 0;
function setHover(tip: string | null): void {
  clearTimeout(hoverTimer);
  if (!tip) { if (hoverTip) { hoverTip = null; render(); } return; }
  if (tip === hoverTip) return;
  // A short delay so sweeping the pointer across tags doesn't flicker the graph.
  hoverTimer = window.setTimeout(() => { hoverTip = tip; render(); }, hoverTip ? 0 : 150);
}

function addEdge(p: Path2D, x0: number, y0: number, x1: number, y1: number): void {
  p.moveTo(x0, y0);
  if (x0 === x1) { p.lineTo(x1, y1); return; }
  const ym = (y0 + y1) / 2;
  p.bezierCurveTo(x0, ym, x1, ym, x1, y1);
}

// ---------- detail ----------
function select(hash: string | null, scrollIntoView = false): void {
  selected = hash;
  if (hash) {
    post({ type: 'select', hash });
    if (scrollIntoView) {
      const v = view.indexOf(indexByHash.get(hash) ?? -1);
      if (v >= 0) {
        const y = v * config.rowHeight;
        if (y < scroller.scrollTop || y + config.rowHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2);
      }
    }
  } else {
    detailEl.hidden = true;
  }
  render();
}

/** The detail pane's current file list and the file whose diff is shown. */
let detailFiles: CommitFile[] = [];
let activeFile: string | null = null;

function showDetail(d: CommitDetail): void {
  if (d.hash !== selected) return;
  const i = indexByHash.get(d.hash);
  const c = i !== undefined ? commits[i] : undefined;
  detailEl.hidden = false;
  const meta = $('detail-meta');
  meta.replaceChildren();
  const hashEl = $('detail-hash');
  let body = d.body;
  if (d.hash === UNCOMMITTED) {
    $('detail-subject').textContent = 'Uncommitted changes';
    hashEl.textContent = '';
    meta.append('Working tree and index, relative to HEAD');
  } else {
    // The subject is already the title; the body pane shows the rest of the message.
    const nl = body.indexOf('\n');
    $('detail-subject').textContent = nl < 0 ? body : body.slice(0, nl);
    body = nl < 0 ? '' : body.slice(nl + 1).replace(/^\n+/, '');
    hashEl.textContent = d.hash.slice(0, 8);
    hashEl.title = `${d.hash}\nClick to copy`;
    if (c) {
      const who = document.createElement('span');
      who.className = 'who';
      if (config.avatars) { const av = document.createElement('span'); av.className = 'avatar'; renderAvatar(av, c); who.append(av); }
      const name = document.createElement('span');
      name.textContent = c.author;
      name.title = c.email;
      who.append(name);
      meta.append(who, sep(), new Date(c.date * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
      if (d.committer && d.committer !== c.author) meta.append(sep(), `committed by ${d.committer}`);
      if (c.parents.length) {
        meta.append(sep(), c.parents.length > 1 ? 'parents ' : 'parent ');
        c.parents.forEach((p, k) => {
          const a = document.createElement('a'); a.href = '#'; a.className = 'mono'; a.textContent = p.slice(0, 8);
          a.onclick = (e) => { e.preventDefault(); revealHash(p); };
          if (k) meta.append(', ');
          meta.append(a);
        });
      }
    }
  }
  $('detail-body').textContent = body;
  $('detail-body').hidden = !body;
  renderFiles(d.hash, d.files);
}

function sep(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'sep';
  s.textContent = '·';
  return s;
}

function renderFiles(hash: string, list: CommitFile[]): void {
  detailFiles = list;
  const files = $('detail-files');
  files.replaceChildren();
  const summary = document.createElement('div');
  summary.className = 'files-summary';
  summary.textContent = `${list.length} file${list.length === 1 ? '' : 's'} changed`;
  files.append(summary);
  for (const f of list) {
    const line = document.createElement('div');
    line.className = `file status-${f.status}`;
    line.dataset.path = f.path;
    const st = document.createElement('span');
    st.className = 'status';
    st.title = statusName(f.status);
    st.textContent = f.status === '?' ? 'U' : f.status;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = basename(f.path);
    const slash = f.path.lastIndexOf('/');
    const dir = document.createElement('span');
    dir.className = 'dir';
    dir.textContent = f.oldPath ? `${f.oldPath} →` : slash > 0 ? f.path.slice(0, slash) : '';
    line.append(st, name, dir);
    line.title = `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}\nDouble-click to open in the diff editor`;
    line.onclick = () => showFile(hash, f);
    line.ondblclick = () => post({ type: 'openFile', hash, path: f.path, status: f.status, oldPath: f.oldPath });
    files.append(line);
  }
  // Keep the open file across refreshes; otherwise start with the first one.
  const keep = list.find((f) => f.path === activeFile) ?? list[0];
  if (keep) showFile(hash, keep);
  else { activeFile = null; renderDiff(null, '', 'No changes.'); }
}

let diffFor: { hash: string; path: string } | null = null;
let renderedDiff = '';
function showFile(hash: string, f: CommitFile): void {
  activeFile = f.path;
  for (const el of document.querySelectorAll<HTMLElement>('#detail-files .file')) {
    const on = el.dataset.path === f.path;
    el.classList.toggle('active', on);
    if (on) el.scrollIntoView({ block: 'nearest' });
  }
  $('diff-path').textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  $('diff-path').title = f.path;
  $('diff-open').onclick = () => post({ type: 'openFile', hash, path: f.path, status: f.status, oldPath: f.oldPath });
  diffFor = { hash, path: f.path };
  $('diff').classList.add('loading');
  post({ type: 'diff', hash, path: f.path, status: f.status, oldPath: f.oldPath });
}

const MAX_DIFF_LINES = 8000;
/** Renders a unified diff with old/new line numbers; `note` replaces it (empty, binary, error). */
function renderDiff(text: string | null, _path: string, note?: string): void {
  const el = $('diff');
  el.classList.remove('loading');
  // A refresh of the same file (e.g. uncommitted changes being edited) keeps the scroll position.
  const key = diffFor ? `${diffFor.hash}\0${diffFor.path}` : '';
  const keepScroll = key === renderedDiff;
  renderedDiff = key;
  const [top, left] = [el.scrollTop, el.scrollLeft];
  el.replaceChildren();
  const stats = $('diff-stats');
  stats.replaceChildren();
  const message = (t: string) => { const m = document.createElement('div'); m.className = 'diff-note'; m.textContent = t; el.append(m); };
  if (note || text === null) { message(note ?? ''); return; }
  const table = document.createElement('div');
  table.className = 'diff-table';
  let o = 0, n = 0, adds = 0, dels = 0, count = 0, inHunk = false, binary = false, truncated = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const row = (cls: string, a: number | '', b: number | '', code: string) => {
    const r = document.createElement('div');
    r.className = `dl ${cls}`;
    const la = document.createElement('span'); la.className = 'ln'; la.textContent = String(a);
    const lb = document.createElement('span'); lb.className = 'ln'; lb.textContent = String(b);
    const c = document.createElement('span'); c.className = 'code'; c.textContent = code;
    r.append(la, lb, c);
    table.append(r);
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
      if (m) { o = Number(m[1]); n = Number(m[2]); inHunk = true; if (count < MAX_DIFF_LINES) row('hunk', '', '', m[3] ? `⋯ ${m[3]}` : '⋯'); continue; }
    }
    if (!inHunk) { if (line.startsWith('Binary files')) binary = true; continue; }
    const ch = line[0];
    if (ch === '+') adds++;
    else if (ch === '-') dels++;
    if (++count > MAX_DIFF_LINES) { truncated = true; continue; }
    if (ch === '+') row('add', '', n++, line.slice(1));
    else if (ch === '-') row('del', o++, '', line.slice(1));
    else if (ch === '\\') row('meta', '', '', line.slice(2));
    else row('ctx', o++, n++, line.slice(1));
  }
  if (binary) { message('Binary file, not shown.'); return; }
  if (!table.childElementCount) { message('No textual changes (mode or rename only).'); return; }
  const add = document.createElement('span'); add.className = 'adds'; add.textContent = `+${adds}`;
  const del = document.createElement('span'); del.className = 'dels'; del.textContent = `−${dels}`;
  stats.append(add, ' ', del);
  el.append(table);
  if (keepScroll) { el.scrollTop = top; el.scrollLeft = left; } else { el.scrollTop = 0; el.scrollLeft = 0; }
  if (truncated) message(`Diff truncated after ${MAX_DIFF_LINES} lines. Open it in the diff editor to see the rest.`);
}

function statusName(s: string): string {
  return { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Unmerged', '?': 'Untracked' }[s] ?? s;
}

function revealHash(hash: string): void {
  const i = indexByHash.get(hash);
  if (i !== undefined) {
    if (filterText) { filterEl.value = ''; filterText = ''; rebuildView(); }
    select(hash, true);
    pendingReveal = null;
    return;
  }
  pendingReveal = hash;
  revealAttempts = 0;
  if (hasMore) post({ type: 'loadMore' });
}

// ---------- helpers ----------
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function formatDate(unix: number): string {
  const d = new Date(unix * 1000);
  if (config.dateFormat === 'iso') return d.toISOString().slice(0, 16).replace('T', ' ');
  if (config.dateFormat === 'absolute') return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return relativeTime(d.getTime());
}

function relativeTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.round(s / 86400), 'day');
  if (s < 86400 * 365) return rtf.format(-Math.round(s / (86400 * 30)), 'month');
  return rtf.format(-Math.round(s / (86400 * 365)), 'year');
}

function rebuildIndexes(): void {
  indexByHash = new Map(commits.map((c, i) => [c.hash, i]));
  headHash = commits.find((c) => c.refs.some((r) => r.isHead))?.hash ?? null;
  worktreesByHead = new Map();
  worktreesByBranch = new Map();
  for (const wt of worktrees) {
    const list = worktreesByHead.get(wt.head) ?? [];
    list.push(wt);
    worktreesByHead.set(wt.head, list);
    if (wt.branch) worktreesByBranch.set(wt.branch, wt);
  }
}

// ---------- events ----------
scroller.addEventListener('scroll', scheduleRender, { passive: true });
new ResizeObserver(scheduleRender).observe(scroller);
// Coming back to the tab: anything that arrived while hidden still needs drawing at the real size.
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
window.addEventListener('focus', scheduleRender);
window.addEventListener('resize', scheduleRender);
hscroll.addEventListener('scroll', () => { graphX = hscroll.scrollLeft; scheduleRender(); }, { passive: true });
scroller.addEventListener('wheel', (e) => {
  // Shift+wheel (or a horizontal wheel) over the graph column pans the lanes.
  if (hscroll.hidden) return;
  const overGraph = e.clientX < scroller.getBoundingClientRect().left + graphVisibleWidth();
  const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
  if (!overGraph || dx === 0) return;
  e.preventDefault();
  hscroll.scrollLeft += dx;
}, { passive: false });
rowsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('.c-hash')) { const row = t.closest<HTMLElement>('.row'); if (row?.dataset.hash && row.dataset.hash !== UNCOMMITTED) post({ type: 'copy', text: row.dataset.hash }); return; }
  const row = t.closest<HTMLElement>('.row');
  if (row?.dataset.hash) select(row.dataset.hash === selected ? null : row.dataset.hash);
});
// Right-click outlines the menu's target row without selecting it (no detail pane).
// The outline clears on the next interaction, i.e. once the menu is dismissed or used.
rowsEl.addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  contextHash = row?.dataset.hash ?? null;
  render();
});
rowsEl.addEventListener('pointerover', (e) => setHover((e.target as HTMLElement).closest<HTMLElement>('[data-tip]')?.dataset.tip ?? null));
rowsEl.addEventListener('pointerleave', () => setHover(null));
scroller.addEventListener('scroll', () => setHover(null), { passive: true });
const clearContext = () => { if (contextHash) { contextHash = null; render(); } };
for (const ev of ['pointerdown', 'keydown', 'blur', 'focus'] as const) window.addEventListener(ev, clearContext, true);
for (const b of document.querySelectorAll<HTMLButtonElement>('#opbar [data-op]')) {
  b.onclick = () => post({ type: 'operation', action: b.dataset.op as OperationAction });
}
$('detail-close').onclick = () => select(null);
$('detail-hash').onclick = () => { if (selected && selected !== UNCOMMITTED) post({ type: 'copy', text: selected }); };
$('fetch').onclick = () => post({ type: 'fetch' });
repoSel.onchange = () => post({ type: 'selectRepo', repo: repoSel.value });
let filterTimer = 0;
filterEl.oninput = () => { clearTimeout(filterTimer); filterTimer = window.setTimeout(() => { filterText = filterEl.value; rebuildView(); }, 80); };
scroller.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { select(null); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const cur = selected ? view.indexOf(indexByHash.get(selected) ?? -1) : -1;
  const next = Math.max(0, Math.min(view.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
  const i = view[next];
  if (i !== undefined) select(commits[i]!.hash, true);
});

// Detail pane: drag its top edge for height, and the divider between files and diff for the list width.
function dragResize(handle: HTMLElement, onMove: (ev: PointerEvent, start: PointerEvent) => void): void {
  handle.addEventListener('pointerdown', (start) => {
    start.preventDefault();
    handle.setPointerCapture(start.pointerId);
    handle.classList.add('dragging');
    const move = (ev: PointerEvent) => { onMove(ev, start); applyCss(); scheduleRender(); };
    const up = () => { handle.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); persist(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}
{
  let startH = 0, startW = 0;
  const h = $('detail-resize'), v = $('detail-split');
  h.addEventListener('pointerdown', () => { startH = detailEl.getBoundingClientRect().height; }, true);
  v.addEventListener('pointerdown', () => { startW = $('detail-side').getBoundingClientRect().width; }, true);
  dragResize(h, (ev, s) => { persisted.detailH = Math.round(Math.max(140, Math.min(window.innerHeight - 140, startH - (ev.clientY - s.clientY)))); });
  dragResize(v, (ev, s) => { persisted.filesW = Math.round(Math.max(180, Math.min(detailEl.clientWidth - 240, startW + ev.clientX - s.clientX))); });
}

// Column resizing: drag the handle on the Author / Date headers.
for (const handle of document.querySelectorAll<HTMLElement>('.resize')) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const key = handle.dataset.col as 'colAuthor' | 'colDate';
    const startX = e.clientX;
    const startW = persisted[key] ?? (key === 'colAuthor' ? 170 : 130);
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      persisted[key] = Math.max(60, Math.min(500, startW + ev.clientX - startX));
      applyCss();
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); persist(); scheduleRender(); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// "Last fetched" label on the fetch button, re-rendered every 30s so the age stays current.
let lastFetch: number | undefined;
const STALE_MS = 60 * 60 * 1000;
function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function renderFetchAge(): void {
  const btn = $('fetch');
  const label = $('fetch-age');
  if (lastFetch === undefined) {
    label.textContent = 'never';
    btn.title = 'Never fetched. Click to fetch all remotes';
    btn.classList.add('stale');
    return;
  }
  const age = Date.now() - lastFetch;
  label.textContent = shortAge(age);
  const when = new Date(lastFetch).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  btn.title = `Last fetched ${relativeTime(lastFetch)} (${when}). Click to fetch all remotes`;
  btn.classList.toggle('stale', age > STALE_MS);
}
window.setInterval(() => { if (currentRepo) renderFetchAge(); }, 30000);

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'config':
      config = m.config;
      applyCss();
      render();
      break;
    case 'repos':
      repoSel.replaceChildren(...m.repos.map((r) => { const o = document.createElement('option'); o.value = r.path; o.textContent = r.label; o.title = r.path; return o; }));
      repoSel.value = m.current;
      repoSel.hidden = m.repos.length < 2;
      break;
    case 'commits': {
      const repoChanged = currentRepo !== m.repo;
      currentRepo = m.repo;
      if (m.append) { commits.push(...m.commits); rows.push(...m.rows); }
      else {
        commits = m.commits; rows = m.rows;
        if (repoChanged) { scroller.scrollTop = 0; selected = null; detailEl.hidden = true; }
      }
      tail = m.tail;
      hasMore = m.hasMore;
      maxLanes = m.maxLanes;
      rebuildIndexes();
      applyCss();
      rebuildView();
      if (pendingReveal) {
        if (indexByHash.has(pendingReveal)) revealHash(pendingReveal);
        else if (hasMore && ++revealAttempts < 40) post({ type: 'loadMore' });
        else pendingReveal = null;
      } else if (selected && !indexByHash.has(selected)) {
        select(null);
      } else if (selected && !m.append) {
        post({ type: 'select', hash: selected }); // refresh the detail pane after a reload
      }
      break;
    }
    case 'status': {
      // Only the file list of the uncommitted row changed; patch it in place.
      const first = commits[0];
      if (first?.hash === UNCOMMITTED) {
        first.subject = `Uncommitted changes (${m.files.length} file${m.files.length === 1 ? '' : 's'})`;
        render();
        if (selected === UNCOMMITTED) renderFiles(UNCOMMITTED, m.files); // also refreshes the open file's diff
      }
      break;
    }
    case 'worktrees':
      worktrees = m.worktrees;
      rebuildIndexes();
      render();
      break;
    case 'avatars':
      for (const [k, v] of Object.entries(m.avatars)) avatars.set(k, v);
      render();
      break;
    case 'detail':
      showDetail(m.detail);
      break;
    case 'diff':
      if (diffFor && diffFor.hash === m.hash && diffFor.path === m.path) renderDiff(m.error ? null : m.text, m.path, m.error);
      break;
    case 'operation':
      renderOperation(m.op);
      break;
    case 'loading':
      loading = m.loading;
      $('spinner').hidden = !loading;
      $('empty').hidden = view.length > 0 || loading;
      break;
    case 'lastFetch':
      lastFetch = m.time;
      renderFetchAge();
      break;
    case 'reveal':
      revealHash(m.hash);
      break;
    case 'error': {
      const el = $('error');
      el.textContent = m.message;
      el.hidden = false;
      clearTimeout((el as unknown as { _t?: number })._t);
      (el as unknown as { _t?: number })._t = window.setTimeout(() => { el.hidden = true; }, 6000);
      break;
    }
  }
});

applyCss();
post({ type: 'ready' });
