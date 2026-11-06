import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLayout } from '../src/graph/layout.js';

function run(commits: [string, string[]][]) {
  const g = new GraphLayout(10);
  const rows = commits.map(([hash, parents]) => g.add({ hash, parents }));
  return { g, rows };
}

test('linear history stays in lane 0 with straight edges', () => {
  const { rows, g } = run([['c', ['b']], ['b', ['a']], ['a', []]]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[0]!.edges, []);
  assert.deepEqual(rows[1]!.edges, [{ from: 0, to: 0, color: 0 }]);
  assert.deepEqual(rows[2]!.edges, [{ from: 0, to: 0, color: 0 }]);
  assert.equal(g.maxLanes, 1);
  assert.deepEqual(g.tail(), []);
});

test('merge commit opens a second lane that rejoins at the base', () => {
  // m merges f into main; f branched from a.
  //  m (parents b, f)
  //  b (a)
  //  f (a)
  //  a
  const { rows, g } = run([['m', ['b', 'f']], ['b', ['a']], ['f', ['a']], ['a', []]]);
  assert.equal(rows[0]!.lane, 0);
  assert.equal(rows[1]!.lane, 0);
  assert.equal(rows[2]!.lane, 1);
  assert.equal(rows[3]!.lane, 0);
  // Between m and b: straight 0->0 plus the merge strand 0->1 in the new lane's color.
  assert.deepEqual(rows[1]!.edges, [{ from: 0, to: 0, color: 0 }, { from: 0, to: 1, color: 1 }]);
  // Between b and f: both lanes straight.
  assert.deepEqual(rows[2]!.edges, [{ from: 0, to: 0, color: 0 }, { from: 1, to: 1, color: 1 }]);
  // Between f and a: lane 0 straight, lane 1 curves into lane 0 (f's own color).
  assert.deepEqual(rows[3]!.edges, [{ from: 0, to: 0, color: 0 }, { from: 1, to: 0, color: 1 }]);
  assert.equal(g.maxLanes, 2);
});

test('unmerged branch tip gets its own lane and joins its base', () => {
  //  t (tip of feature, parent a)
  //  c (main, parent a)
  //  a
  const { rows } = run([['t', ['a']], ['c', ['a']], ['a', []]]);
  assert.equal(rows[0]!.lane, 0);
  assert.equal(rows[1]!.lane, 1);
  assert.equal(rows[2]!.lane, 0);
  // c's first parent `a` is already expected in lane 0, so c's lane ends with a join into 0.
  assert.deepEqual(rows[2]!.edges, [{ from: 0, to: 0, color: 0 }, { from: 1, to: 0, color: 1 }]);
});

test('freed lanes are reused and trailing lanes are trimmed', () => {
  const { g } = run([['t', ['a']], ['c', ['a']], ['a', ['z']], ['z', []]]);
  // After `a`, only lane 0 is active; the tail should report a single strand.
  assert.equal(g.rows[2]!.lane, 0);
  assert.deepEqual(g.rows[3]!.edges, [{ from: 0, to: 0, color: 0 }]);
});

test('octopus merge fans out to each parent', () => {
  const { rows, g } = run([['m', ['a', 'b', 'c']], ['a', []], ['b', []], ['c', []]]);
  assert.equal(rows[0]!.lane, 0);
  assert.deepEqual(rows[1]!.edges.map((e) => [e.from, e.to]), [[0, 0], [0, 1], [0, 2]]);
  assert.equal(g.maxLanes, 3);
});

test('streaming: tail reports open strands between pages', () => {
  const g = new GraphLayout();
  g.add({ hash: 'm', parents: ['b', 'f'] });
  const tail = g.tail();
  assert.deepEqual(tail.map((e) => [e.from, e.to]), [[0, 0], [0, 1]]);
  g.add({ hash: 'b', parents: ['a'] });
  assert.deepEqual(g.rows[1]!.edges.map((e) => [e.from, e.to]), [[0, 0], [0, 1]]);
});
