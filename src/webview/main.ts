import type { Commit, CommitDetail, Edge, GraphConfig, HostMessage, Row, WebviewMessage, Worktree } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(m: WebviewMessage): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);

// ---------- state ----------
let config: GraphConfig = { laneWidth: 14, rowHeight: 24, colors: ['#4e9bff'], dateFormat: 'relative' };
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
let selected: string | null = null;
let pendingReveal: string | null = null;
let revealAttempts = 0;
let headHash: string | null = null;

// ---------- DOM ----------
const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="toolbar">
    <select id="repo" title="Repository"></select>
    <input id="filter" type="search" placeholder="Filter by message, author or hash…" spellcheck="false">
    <span id="count"></span>
    <span id="spinner" class="codicon codicon-loading codicon-modifier-spin" hidden></span>
    <button id="refresh" class="icon-btn" title="Refresh"><span class="codicon codicon-refresh"></span></button>
  </div>
  <div id="header">
    <div class="c-graph">Graph</div><div class="c-desc">Description</div><div class="c-author">Author</div><div class="c-date">Date</div><div class="c-hash">Commit</div>
  </div>
  <div id="scroller" tabindex="0">
    <div id="spacer"></div>
    <canvas id="graph"></canvas>
    <div id="rows"></div>
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
const canvas = $('graph') as HTMLCanvasElement;
const rowsEl = $('rows');
const repoSel = $('repo') as HTMLSelectElement;
const filterEl = $('filter') as HTMLInputElement;
const detailEl = $('detail');
const ctx2d = canvas.getContext('2d')!;

// Filtering produces a view: list of commit indices to show.
let view: number[] = [];
let filterText = '';

function applyCss(): void {
  const graphW = Math.max(3, Math.min(maxLanes, 24)) * config.laneWidth + 16;
  // Set on :root so --cols (declared there) resolves against the live values.
  const root = document.documentElement.style;
  root.setProperty('--row-h', `${config.rowHeight}px`);
  root.setProperty('--graph-w', `${graphW}px`);
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
  $('count').textContent = q ? `${view.length} / ${commits.length}` : `${commits.length}${hasMore ? '+' : ''}`;
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

  // Rows (pooled DOM nodes)
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
    fillRow(el, c, rows[i]!);
  }
  for (let k = used; k < pool.length; k++) pool[k]!.hidden = true;

  // Graph canvas (hidden while filtering: lanes don't make sense for a sparse subset)
  canvas.hidden = filtered;
  if (!filtered) drawGraph(first, last, top, height);

  // Infinite scroll
  if (hasMore && !loading && last >= view.length - 60) post({ type: 'loadMore' });
}

function createRowEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = '<div class="c-graph"></div><div class="c-desc"><span class="refs"></span><span class="subject"></span></div><div class="c-author"></div><div class="c-date"></div><div class="c-hash mono"></div>';
  return el;
}

function fillRow(el: HTMLDivElement, c: Commit, row: Row): void {
  const desc = el.children[1] as HTMLElement;
  const refs = desc.children[0] as HTMLElement;
  const subject = desc.children[1] as HTMLElement;
  const color = config.colors[row.color % config.colors.length] ?? '#888';
  refs.replaceChildren(...refChips(c, color));
  subject.textContent = c.subject;
  (el.children[2] as HTMLElement).textContent = c.author;
  (el.children[2] as HTMLElement).title = `${c.author} <${c.email}>`;
  (el.children[3] as HTMLElement).textContent = formatDate(c.date);
  (el.children[3] as HTMLElement).title = new Date(c.date * 1000).toLocaleString();
  (el.children[4] as HTMLElement).textContent = c.hash.slice(0, 8);
}

function refChips(c: Commit, color: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const shownWorktrees = new Set<string>();
  for (const r of c.refs) {
    const chip = document.createElement('span');
    chip.className = `chip ${r.kind}${r.isHead ? ' is-head' : ''}`;
    chip.style.setProperty('--chip', color);
    const icon = r.kind === 'tag' ? 'tag' : r.kind === 'remote' ? 'cloud' : 'git-branch';
    chip.innerHTML = `<span class="codicon codicon-${icon}"></span>`;
    chip.append(r.name);
    chip.title = r.kind === 'remote' ? `Remote branch ${r.name}` : r.kind === 'tag' ? `Tag ${r.name}` : `Branch ${r.name}${r.isHead ? ' (HEAD)' : ''}`;
    const wt = r.kind === 'branch' ? worktreesByBranch.get(r.name) : undefined;
    if (wt) {
      // A branch checked out in a worktree: fold the worktree badge into the branch chip.
      shownWorktrees.add(wt.path);
      chip.classList.add('has-worktree', wt.locked ? 'locked' : 'unlocked');
      chip.append(worktreeBadge(wt));
      chip.title += `\nWorktree: ${wt.path}${wt.locked ? `\n🔒 Locked${wt.lockReason ? ': ' + wt.lockReason : ''}` : ''}\nClick the folder icon for actions`;
    }
    out.push(chip);
  }
  for (const wt of worktreesByHead.get(c.hash) ?? []) {
    if (shownWorktrees.has(wt.path)) continue;
    // Detached worktree (or branch not decorated): its own chip.
    const chip = document.createElement('span');
    chip.className = `chip worktree ${wt.locked ? 'locked' : 'unlocked'}`;
    chip.style.setProperty('--chip', color);
    chip.append(worktreeBadge(wt), wt.branch ?? basename(wt.path));
    chip.title = `Worktree: ${wt.path}${wt.detached ? ' (detached)' : ''}${wt.locked ? `\n🔒 Locked${wt.lockReason ? ': ' + wt.lockReason : ''}` : ''}\nClick for actions`;
    chip.dataset.worktree = wt.path;
    out.push(chip);
  }
  return out;
}

function worktreeBadge(wt: Worktree): HTMLElement {
  const b = document.createElement('span');
  b.className = 'wt-badge';
  b.dataset.worktree = wt.path;
  b.innerHTML = `<span class="codicon codicon-${wt.isMain ? 'root-folder' : 'folder'}"></span>${wt.locked ? '<span class="codicon codicon-lock lock"></span>' : ''}`;
  return b;
}

function drawGraph(first: number, last: number, top: number, height: number): void {
  const dpr = window.devicePixelRatio || 1;
  const rowH = config.rowHeight;
  const laneW = config.laneWidth;
  const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--graph-w')) || 60;
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
  const x = (lane: number) => 8 + lane * laneW + laneW / 2;
  const y = (r: number) => r * rowH + rowH / 2 - top;
  const colorOf = (c: number) => config.colors[c % config.colors.length] ?? '#888';

  // Edges, batched per color to reduce state changes.
  const byColor = new Map<number, Path2D>();
  const pathFor = (c: number) => { let p = byColor.get(c); if (!p) { p = new Path2D(); byColor.set(c, p); } return p; };
  const n = view.length;
  const rFirst = Math.max(0, first);
  const rLast = Math.min(n - 1, last + 1);
  for (let r = rFirst; r <= rLast; r++) {
    const row = rows[r]!;
    const y0 = y(r - 1), y1 = y(r);
    for (const e of row.edges) addEdge(pathFor(e.color), x(e.from), y0, x(e.to), y1);
  }
  if (hasMore && last >= n - 2 && n > 0) {
    // Tail: open strands continuing below the last loaded row.
    const y0 = y(n - 1), y1 = y0 + rowH * 0.6;
    for (const e of tail) addEdge(pathFor(e.color), x(e.from), y0, x(e.to), y1);
  }
  for (const [c, p] of byColor) { g.strokeStyle = colorOf(c); g.stroke(p); }

  // Nodes
  const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background') || '#1e1e1e';
  for (let r = rFirst; r <= Math.min(n - 1, last); r++) {
    const row = rows[r]!;
    const c = commits[r]!;
    const cx = x(row.lane), cy = y(r);
    const col = colorOf(row.color);
    g.beginPath();
    if (c.hash === headHash) {
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
  $('detail-hash').textContent = d.hash;
  const meta = $('detail-meta');
  meta.replaceChildren();
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
  $('detail-body').textContent = d.body;
  const files = $('detail-files');
  files.replaceChildren();
  for (const f of d.files) {
    const line = document.createElement('div');
    line.className = `file status-${f.status}`;
    line.innerHTML = `<span class="status">${f.status}</span>`;
    line.append(f.oldPath ? `${f.oldPath} → ${f.path}` : f.path);
    line.title = 'Open diff';
    line.onclick = () => post({ type: 'openFile', hash: d.hash, path: f.path, status: f.status, oldPath: f.oldPath });
    files.append(line);
  }
  const summary = document.createElement('div');
  summary.className = 'files-summary';
  summary.textContent = `${d.files.length} file${d.files.length === 1 ? '' : 's'} changed`;
  files.prepend(summary);
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
rowsEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const wtEl = t.closest<HTMLElement>('[data-worktree]');
  if (wtEl?.dataset.worktree) { e.stopPropagation(); post({ type: 'worktreeMenu', path: wtEl.dataset.worktree }); return; }
  if (t.closest('.c-hash')) { const row = t.closest<HTMLElement>('.row'); if (row?.dataset.hash) post({ type: 'copy', text: row.dataset.hash }); return; }
  const row = t.closest<HTMLElement>('.row');
  if (row?.dataset.hash) select(row.dataset.hash === selected ? null : row.dataset.hash);
});
$('detail-close').onclick = () => select(null);
$('detail-hash').onclick = () => { if (selected) post({ type: 'copy', text: selected }); };
$('refresh').onclick = () => post({ type: 'refresh' });
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
    case 'commits':
      if (m.append) { commits.push(...m.commits); rows.push(...m.rows); }
      else { commits = m.commits; rows = m.rows; scroller.scrollTop = 0; }
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
      }
      break;
    case 'worktrees':
      worktrees = m.worktrees;
      rebuildIndexes();
      render();
      break;
    case 'detail':
      showDetail(m.detail);
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
      clearTimeout((el as any)._t);
      (el as any)._t = setTimeout(() => { el.hidden = true; }, 6000);
      break;
    }
  }
});

applyCss();
post({ type: 'ready' });
