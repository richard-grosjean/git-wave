import type { Edge, Row } from '../shared/types';

export interface LayoutInput {
  hash: string;
  parents: string[];
}

interface Join {
  from: number;
  hash: string;
  color: number;
}

/**
 * Incremental lane layout for a commit DAG.
 *
 * Feed commits in an order where every child precedes its parents (git's default,
 * `--topo-order`, or `--date-order` all satisfy this). Each call to `add` returns the
 * Row for that commit, whose `edges` describe the strands between the previous row and
 * this one. The layout keeps only O(active lanes) state, so it streams: pages of
 * commits can be appended later without recomputing earlier rows.
 */
export class GraphLayout {
  /** Hash each lane is waiting for (the next commit that will land in it), or null if free. */
  private lanes: (string | null)[] = [];
  private laneColor: number[] = [];
  /** Extra strands that leave a node sideways into another lane in the next interval. */
  private joins: Join[] = [];
  /** Lanes allocated for merge parents on the current row; they start at the node, not above it. */
  private fresh = new Set<number>();
  private colorCursor = 0;
  private readonly colorCount: number;
  readonly rows: Row[] = [];
  maxLanes = 0;

  constructor(colorCount = 10) {
    this.colorCount = Math.max(1, colorCount);
  }

  add(c: LayoutInput): Row {
    const lanes = this.lanes;

    // 1. Strands entering this row from above.
    const strands: Join[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const h = lanes[i];
      if (h !== null && h !== undefined && !this.fresh.has(i)) {
        strands.push({ from: i, hash: h, color: this.laneColor[i] ?? 0 });
      }
    }
    for (const j of this.joins) strands.push(j);
    this.joins = [];
    this.fresh.clear();

    // 2. Which lane does this commit land in? The lowest lane expecting it, else a free one.
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.hash) { lane = i; break; }
    }
    if (lane < 0) {
      lane = this.allocate();
      this.laneColor[lane] = this.nextColor(); // pick before marking the lane active
      lanes[lane] = c.hash;
    }
    const color = this.laneColor[lane] ?? 0;

    // 3. Resolve the strands above into concrete edges now that we know where the node is.
    // Lowest lane wins when several lanes expect the same hash (matches indexOf semantics).
    const pos = new Map<string, number>();
    for (let i = lanes.length - 1; i >= 0; i--) {
      const h = lanes[i];
      if (h !== null && h !== undefined) pos.set(h, i);
    }
    const edges: Edge[] = [];
    for (const s of strands) {
      const to = s.hash === c.hash ? lane : pos.get(s.hash) ?? -1;
      if (to < 0) continue; // defensive: should not happen
      edges.push({ from: s.from, to, color: s.color });
    }

    // Any other lane that was waiting for this commit merges in here and ends.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === c.hash) lanes[i] = null;
    }

    // 4. Parents decide what continues below this row.
    const parents = dedupe(c.parents);
    let endOwnLane = false;
    if (parents.length === 0) {
      endOwnLane = true;
    } else {
      const p0 = parents[0]!;
      const k0 = lanes.indexOf(p0);
      if (k0 < 0) {
        lanes[lane] = p0; // the branch continues straight down this lane
      } else {
        // First parent is already expected elsewhere: this branch ends and curves into it.
        endOwnLane = true;
        this.joins.push({ from: lane, hash: p0, color });
      }
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i]!;
        const k = lanes.indexOf(p);
        if (k >= 0) {
          this.joins.push({ from: lane, hash: p, color: this.laneColor[k] ?? 0 });
        } else {
          const nl = this.allocate(lane);
          const nc = this.nextColor();
          this.laneColor[nl] = nc;
          lanes[nl] = p;
          this.fresh.add(nl);
          this.joins.push({ from: lane, hash: p, color: nc });
        }
      }
    }
    if (endOwnLane) lanes[lane] = null;

    // Trim trailing free lanes so width shrinks back after wide sections.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      this.laneColor.pop();
    }

    const row: Row = { lane, color, edges };
    this.rows.push(row);
    const width = Math.max(lane + 1, ...edges.map((e) => Math.max(e.from, e.to) + 1));
    if (width > this.maxLanes) this.maxLanes = width;
    return row;
  }

  /** Strands still open after the last row, for drawing a tail that signals "more below". */
  tail(): Edge[] {
    const out: Edge[] = [];
    for (let i = 0; i < this.lanes.length; i++) {
      const h = this.lanes[i];
      if (h !== null && h !== undefined && !this.fresh.has(i)) out.push({ from: i, to: i, color: this.laneColor[i] ?? 0 });
    }
    for (const j of this.joins) {
      const to = this.lanes.indexOf(j.hash);
      if (to >= 0) out.push({ from: j.from, to, color: j.color });
    }
    return out;
  }

  private allocate(avoid = -1): number {
    for (let i = 0; i < this.lanes.length; i++) {
      if (this.lanes[i] === null && i !== avoid) return i;
    }
    this.lanes.push(null);
    this.laneColor.push(0);
    return this.lanes.length - 1;
  }

  private nextColor(): number {
    // Prefer a color no active lane is using, so neighbours rarely share a hue.
    const inUse = new Set<number>();
    for (let i = 0; i < this.lanes.length; i++) {
      if (this.lanes[i] !== null) inUse.add(this.laneColor[i] ?? 0);
    }
    for (let n = 0; n < this.colorCount; n++) {
      const c = (this.colorCursor + n) % this.colorCount;
      if (!inUse.has(c)) {
        this.colorCursor = c + 1;
        return c;
      }
    }
    const c = this.colorCursor % this.colorCount;
    this.colorCursor++;
    return c;
  }
}

function dedupe(parents: string[]): string[] {
  if (parents.length < 2) return parents;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parents) {
    if (!seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}
