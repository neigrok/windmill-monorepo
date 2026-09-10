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
