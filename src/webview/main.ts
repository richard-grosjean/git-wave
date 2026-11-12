import { UNCOMMITTED, type Commit, type CommitDetail, type CommitFile, type Edge, type GraphConfig, type HostMessage, type OperationAction, type OperationState, type Ref, type Row, type WebviewMessage, type Worktree } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);

interface PersistedState { colAuthor?: number; colDate?: number }
const persisted: PersistedState = (vscode.getState() as PersistedState | undefined) ?? {};
const persist = () => vscode.setState(persisted);

// ---------- state ----------
let config: GraphConfig = { laneWidth: 14, rowHeight: 24, colors: ['#4e9bff'], dateFormat: 'relative', avatars: true, visibleLanes: 12 };
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
let pendingReveal: string | null = null;
let revealAttempts = 0;
let headHash: string | null = null;
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
    <button id="fetch" class="icon-btn" title="Fetch all remotes"><span class="codicon codicon-cloud-download"></span></button>
    <button id="refresh" class="icon-btn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
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
    <div id="detail-head">
      <span id="detail-hash" class="mono" title="Click to copy"></span>
      <span id="detail-meta"></span>
      <button id="detail-close" class="icon-btn" title="Close (Esc)"><span class="codicon codicon-close"></span></button>
    </div>
    <pre id="detail-body"></pre>
    <div id="detail-files"></div>
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
  root.setProperty('--graph-w', `${graphVisibleWidth()}px`);
  root.setProperty('--col-author', `${persisted.colAuthor ?? 170}px`);
  root.setProperty('--col-date', `${persisted.colDate ?? 130}px`);
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
  const first = Math.max(0, Math.floor(top / rowH) - 4);
  const last = Math.min(view.length - 1, Math.ceil((top + height) / rowH) + 4);
  const filtered = filterText.trim().length > 0;

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
    el.classList.toggle('head', c.hash === headHash);
    el.classList.toggle('uncommitted', c.hash === UNCOMMITTED);
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
  if (!config.avatars) { el.className = 'avatar'; el.replaceChildren(); return; }
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
 * and the branch's worktree are joined into one segmented tag (`branch | origin | worktree | this window`).
 * Each segment keeps its own right-click menu.
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

/**
 * Worktree segment(s): `worktree-name`, plus a `this window` segment when it's the one open here. Omitted when the
 * repo has a single worktree (unless detached), where it would only repeat the obvious.
 */
function worktreeSegments(wt: Worktree, color: string): HTMLElement[] {
  if (worktrees.length <= 1 && !wt.detached) return [];
  const ctx = JSON.stringify({ webviewSection: 'worktree', path: wt.path, locked: wt.locked, isMain: wt.isMain, isCurrent: !!wt.isCurrent, preventDefaultContextMenuItems: true });
  const title = [
    `${wt.isMain ? 'Main worktree' : 'Worktree'}: ${wt.path}`,
    wt.isCurrent ? 'Open in this window' : '',
    wt.locked ? `Locked${wt.lockReason ? ': ' + wt.lockReason : ''}` : '',
    'Right-click for worktree actions',
  ].filter(Boolean).join('\n');
  const tag = document.createElement('span');
  tag.className = `chip wt${wt.isCurrent ? ' is-current' : ''}${wt.locked ? ' locked' : ''}`;
  tag.style.setProperty('--chip', color);
  tag.innerHTML = '<span class="codicon codicon-worktree"></span>';
  tag.append(wt.detached ? `${basename(wt.path)} (detached)` : basename(wt.path));
  if (wt.locked) tag.insertAdjacentHTML('beforeend', '<span class="codicon codicon-lock lock"></span>');
  tag.title = title;
  tag.dataset.vscodeContext = ctx;
  if (!wt.isCurrent) return [tag];
  const here = document.createElement('span');
  here.className = 'chip wt-here';
  here.textContent = 'this window';
  here.title = title;
  here.dataset.vscodeContext = ctx;
  return [tag, here];
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

  const byColor = new Map<number, Path2D>();
  const pathFor = (c: number) => { let p = byColor.get(c); if (!p) { p = new Path2D(); byColor.set(c, p); } return p; };
  const dashed = new Map<number, Path2D>();
  const dashedFor = (c: number) => { let p = dashed.get(c); if (!p) { p = new Path2D(); dashed.set(c, p); } return p; };
  for (let r = rFirst; r <= rLast; r++) {
    const row = rows[r]!;
    const y0 = y(r - 1), y1 = y(r);
    for (const e of row.edges) {
      // The strand leaving the uncommitted row is dashed until it reaches HEAD.
      const fromUncommitted = hasUncommitted && e.from === rows[0]!.lane && r <= (indexByHash.get(headHash ?? '') ?? -1) && e.color === rows[0]!.color;
      addEdge(fromUncommitted ? dashedFor(e.color) : pathFor(e.color), x(e.from), y0, x(e.to), y1);
    }
  }
  if (hasMore && last >= n - 2 && n > 0) {
    const y0 = y(n - 1), y1 = y0 + rowH * 0.6;
    for (const e of tail) addEdge(pathFor(e.color), x(e.from), y0, x(e.to), y1);
  }
  for (const [c, p] of byColor) { g.strokeStyle = colorOf(c); g.stroke(p); }
  if (dashed.size) {
    g.setLineDash([3, 3]);
    for (const [c, p] of dashed) { g.strokeStyle = colorOf(c); g.stroke(p); }
    g.setLineDash([]);
  }

  const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
  for (let r = rFirst; r <= Math.min(n - 1, last); r++) {
    const row = rows[view[r]!]!;
    const c = commits[view[r]!]!;
    const cx = x(row.lane), cy = y(r);
    if (cx < -8 || cx > width + 8) continue;
    const col = colorOf(row.color);
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
      g.strokeStyle = col; g.lineWidth = 1; g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1; g.lineWidth = 2;
    }
  }
  // Fade hint when more lanes are hidden to the right.
  if (graphFullWidth() - graphX > width + 1) {
    const grad = g.createLinearGradient(width - 14, 0, width, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, bg);
    g.fillStyle = grad;
    g.fillRect(width - 14, 0, 14, height);
  }
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

function showDetail(d: CommitDetail): void {
  if (d.hash !== selected) return;
  const i = indexByHash.get(d.hash);
  const c = i !== undefined ? commits[i] : undefined;
  detailEl.hidden = false;
  const meta = $('detail-meta');
  meta.replaceChildren();
  if (d.hash === UNCOMMITTED) {
    $('detail-hash').textContent = 'Uncommitted changes';
    meta.append('Working tree and index, relative to HEAD. Click a file to see its diff.');
  } else {
    $('detail-hash').textContent = d.hash;
    if (c) {
      meta.append(`${c.author} <${c.email}> · ${new Date(c.date * 1000).toLocaleString()}`);
      if (d.committer && d.committer !== c.author) meta.append(` · committed by ${d.committer}`);
      if (c.parents.length) {
        meta.append(' · parents: ');
        c.parents.forEach((p, k) => {
          const a = document.createElement('a'); a.href = '#'; a.className = 'mono'; a.textContent = p.slice(0, 8);
          a.onclick = (e) => { e.preventDefault(); revealHash(p); };
          if (k) meta.append(', ');
          meta.append(a);
        });
      }
    }
  }
  $('detail-body').textContent = d.body;
  $('detail-body').hidden = !d.body;
  renderFiles(d.hash, d.files);
}

function renderFiles(hash: string, list: CommitFile[]): void {
  const files = $('detail-files');
  files.replaceChildren();
  const summary = document.createElement('div');
  summary.className = 'files-summary';
  summary.textContent = `${list.length} file${list.length === 1 ? '' : 's'} changed`;
  files.append(summary);
  for (const f of list) {
    const line = document.createElement('div');
    line.className = `file status-${f.status}`;
    line.innerHTML = `<span class="status" title="${statusName(f.status)}">${f.status === '?' ? 'U' : f.status}</span>`;
    line.append(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);
    line.title = 'Open diff';
    line.onclick = () => post({ type: 'openFile', hash, path: f.path, status: f.status, oldPath: f.oldPath });
    files.append(line);
  }
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
  const s = (Date.now() - d.getTime()) / 1000;
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
rowsEl.addEventListener('contextmenu', (e) => {
  // Select the row under the cursor so the detail pane matches the menu target.
  const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
  if (row?.dataset.hash && row.dataset.hash !== selected) select(row.dataset.hash);
});
for (const b of document.querySelectorAll<HTMLButtonElement>('#opbar [data-op]')) {
  b.onclick = () => post({ type: 'operation', action: b.dataset.op as OperationAction });
}
$('detail-close').onclick = () => select(null);
$('detail-hash').onclick = () => { if (selected && selected !== UNCOMMITTED) post({ type: 'copy', text: selected }); };
$('refresh').onclick = () => post({ type: 'refresh' });
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
        if (selected === UNCOMMITTED) renderFiles(UNCOMMITTED, m.files);
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
    case 'operation':
      renderOperation(m.op);
      break;
    case 'loading':
      loading = m.loading;
      $('spinner').hidden = !loading;
      $('empty').hidden = view.length > 0 || loading;
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
