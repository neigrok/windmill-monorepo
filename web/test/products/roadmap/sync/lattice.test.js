import test from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock, TreeLattice } from '../../../../src/products/roadmap/sync/lattice.js';

test('legacy authored progress aliases become none through projection, persistence, and replay', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'done', createdAt: '100:0:legacy', status: 'complete', statusAt: '200:0:legacy' },
    { id: 'old-active', createdAt: '100:0:legacy', status: 'active', statusAt: '200:0:legacy' },
    { id: 'old-inProgress', createdAt: '100:0:legacy', status: 'inProgress', statusAt: '200:0:legacy' },
  ] });
  const frame = lattice.toFrame();
  const copy = new TreeLattice('t_1');
  copy.join(frame);

  assert.deepEqual(frame.nodes.map(({ id, status }) => ({ id, status })), [
    { id: 'done', status: 'complete' },
    { id: 'old-active', status: 'none' },
    { id: 'old-inProgress', status: 'none' },
  ]);
  assert.deepEqual(copy.toTreeData().nodes.map(({ id, status }) => ({ id, status })), [
    { id: 'done', status: 'complete' },
    { id: 'old-active', status: 'none' },
    { id: 'old-inProgress', status: 'none' },
  ]);
});

test('createdMs reads the wall time of the add stamp, and a genesis seed stays unknown', () => {
  const planted = Date.UTC(2026, 9, 20, 9);
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'seeded', createdAt: '1:0:genesis', label: 'Seeded', labelAt: '1:0:genesis' },
    { id: 'planted', createdAt: `${planted}:3:srv`, label: 'Planted', labelAt: `${planted}:3:srv` },
  ] });

  assert.deepEqual(lattice.toTreeData().nodes.map(({ id, createdMs }) => ({ id, createdMs })), [
    { id: 'seeded', createdMs: null },
    { id: 'planted', createdMs: planted },
  ]);
});

test('two replicas that trade frames in opposite orders read the same createdMs, and so does a fresh one', () => {
  const t1 = Date.UTC(2026, 9, 20, 9);
  const t2 = Date.UTC(2026, 9, 21, 10);
  const t3 = Date.UTC(2026, 9, 22, 10);
  const t4 = Date.UTC(2026, 9, 23, 10);
  const plant = { nodes: [{ id: 'root', createdAt: `${t1}:0:r_a`, label: 'Sail', labelAt: `${t1}:0:r_a` }] };
  const graft = {
    nodes: [
      { id: 'knots', createdAt: `${t2}:0:r_a`, label: 'Knots', labelAt: `${t2}:0:r_a` },
      { id: 'wind', createdAt: `${t2}:0:r_a`, label: 'Wind', labelAt: `${t2}:0:r_a` },
    ],
    edges: [{ from: 'root', to: 'knots', addedAt: `${t2}:0:r_a` }, { from: 'root', to: 'wind', addedAt: `${t2}:0:r_a` }],
  };
  const rename = { nodes: [{ id: 'knots', label: 'Knots and hitches', labelAt: `${t3}:0:r_b` }] };
  const bowline = {
    nodes: [{ id: 'bowline', createdAt: `${t3}:1:r_b`, label: 'Bowline', labelAt: `${t3}:1:r_b` }],
    edges: [{ from: 'knots', to: 'bowline', addedAt: `${t3}:1:r_b` }],
  };
  const drop = { nodes: [{ id: 'wind', deletedAt: `${t4}:0:r_a` }] };

  const a = new TreeLattice('t_1');
  for (const frame of [plant, graft, drop, rename, bowline]) a.join(frame);
  const b = new TreeLattice('t_1');
  for (const frame of [bowline, rename, drop, graft, plant, graft]) b.join(frame);
  const fresh = new TreeLattice('t_1');
  fresh.join(a.toFrame());

  const created = (lattice) => lattice.toTreeData().nodes
    .map(({ id, createdMs }) => ({ id, createdMs }))
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  const expected = [
    { id: 'bowline', createdMs: t3 },
    { id: 'knots', createdMs: t2 },
    { id: 'root', createdMs: t1 },
  ];
  assert.deepEqual(created(a), expected);
  assert.deepEqual(created(b), expected);
  assert.deepEqual(created(fresh), expected);
});

test('presentEdges includes masked endpoints and self-edges while liveEdges keeps its projection and order', () => {
  const lattice = new TreeLattice('sail');
  lattice.join({ nodes: [
    { id: 'root', createdAt: '100:0:seed' },
    { id: 'wind', createdAt: '100:0:seed', deletedAt: '200:0:seed' },
    { id: 'dock', createdAt: '100:0:seed' },
  ], edges: [
    { from: 'root', to: 'wind', addedAt: '100:0:seed' },
    { from: 'wind', to: 'dock', addedAt: '100:0:seed' },
    { from: 'root', to: 'dock', addedAt: '100:0:seed' },
    { from: 'dock', to: 'dock', addedAt: '100:0:seed' },
    { from: 'absent', to: 'root', addedAt: '100:0:seed', removedAt: '200:0:seed' },
  ] });
  assert.deepEqual(lattice.presentEdges(), [
    { from: 'root', to: 'wind' }, { from: 'wind', to: 'dock' },
    { from: 'root', to: 'dock' }, { from: 'dock', to: 'dock' },
  ]);
  assert.deepEqual(lattice.liveEdges(), [{ from: 'root', to: 'dock' }]);
});

test('two replicas trading guide writes in opposite orders converge on the later stamp, and a fresh one reads it too', () => {
  const first = { guide: { v: 'One step a week, on weekend sails with Maya.', at: '1770000000000:0:r_a' } };
  const later = { guide: { v: 'Two steps a week until the June trip.', at: '1770000000000:1:r_b' } };
  const rename = { title: { v: 'Learn to sail', at: '1770000000000:2:r_a' } };
  const a = new TreeLattice('t_1', 'Sail');
  for (const frame of [first, later, rename]) a.join(frame);
  const b = new TreeLattice('t_1', 'Sail');
  for (const frame of [rename, later, first]) b.join(frame);
  const fresh = new TreeLattice('t_1');
  fresh.join(a.toFrame());

  const registers = (lattice) => ({ title: lattice.title, guide: lattice.guide, frame: { title: lattice.toFrame().title, guide: lattice.toFrame().guide } });
  const expected = { title: 'Learn to sail', guide: later.guide.v, frame: { title: rename.title, guide: later.guide } };
  assert.deepEqual(registers(a), expected);
  assert.deepEqual(registers(b), expected);
  assert.deepEqual(registers(fresh), expected);
  assert.equal(a.toTreeData().guide, later.guide.v);
});

test('a frame that names no guide, or names it null, never clears it; an empty stamped guide does', () => {
  const lattice = new TreeLattice('t_1', 'Sail', 'The document guide');
  assert.deepEqual({ guide: lattice.guide, frame: lattice.toFrame().guide }, { guide: 'The document guide', frame: undefined });
  lattice.join({ guide: { v: 'Written', at: '5:0:r_a' } });
  lattice.join({ nodes: [{ id: 'root', createdAt: '6:0:r_a' }] });
  lattice.join({ title: { v: 'Renamed', at: '7:0:r_a' }, guide: null });
  assert.equal(lattice.guide, 'Written');
  lattice.join({ guide: { v: 'Older', at: '4:0:r_b' } });
  assert.equal(lattice.guide, 'Written');
  lattice.join({ guide: { v: '', at: '8:0:r_b' } });
  assert.deepEqual({ guide: lattice.guide, frame: lattice.toFrame().guide, projected: lattice.toTreeData().guide }, { guide: '', frame: { v: '', at: '8:0:r_b' }, projected: '' });
});

test('the guide stamp joins coverage and the clock, and a baseline keeps its text unstamped', () => {
  const lattice = new TreeLattice('t_1', 'Sail');
  const frontier = lattice.join({ guide: { v: 'Written', at: '9:3:r_g' } });
  assert.deepEqual(frontier.toJSON(), { r_g: '9:3:r_g' });
  assert.deepEqual(lattice.frontier().toJSON(), { r_g: '9:3:r_g' });
  const clock = new HlcClock('r_mine');
  lattice.seedClock(clock);
  assert.deepEqual(clock.tick(1), { ms: 9, counter: 4, actor: 'r_mine' });
  const baseline = lattice.baseline();
  assert.deepEqual({ title: baseline.title, guide: baseline.guide, frame: baseline.toFrame(), frontier: baseline.frontier().toJSON() },
    { title: 'Sail', guide: 'Written', frame: { nodes: [], edges: [], kinds: [] }, frontier: {} });
});

test('a register whose text is not a string makes the whole frame malformed and leaves the lattice untouched', () => {
  const lattice = new TreeLattice('t_1', 'Sail', 'Kept');
  for (const register of [{ guide: { v: 7, at: '5:0:r_a' } }, { guide: { at: '5:0:r_a' } }, { title: { v: null, at: '5:0:r_a' } }]) {
    assert.throws(() => lattice.join({ nodes: [{ id: 'root', createdAt: '5:0:r_a' }], ...register }), { message: 'malformed tree register' });
  }
  assert.deepEqual({ title: lattice.title, guide: lattice.guide, nodes: lattice.nodes.size }, { title: 'Sail', guide: 'Kept', nodes: 0 });
});
