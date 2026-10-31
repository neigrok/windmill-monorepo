import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeLattice, VersionVector } from '../../../../src/products/roadmap/sync/lattice.js';

test('legacy authored progress aliases become none through projection, persistence, and replay', () => {
  const lattice = new TreeLattice('t_1');
  lattice.join({ nodes: [
    { id: 'done', createdAt: '100:0:legacy', status: 'complete', statusAt: '200:0:legacy' },
    { id: 'old-active', createdAt: '100:0:legacy', status: 'active', statusAt: '200:0:legacy' },
    { id: 'old-inProgress', createdAt: '100:0:legacy', status: 'inProgress', statusAt: '200:0:legacy' },
  ] });
  const frame = lattice.deltaSince(new VersionVector());
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
