import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncSession } from '../../../../src/products/roadmap/sync/SyncSession.js';
import { pendingRecordCount, unconfirmedStamps, writeStamps } from '../../../../src/products/roadmap/sync/pendingWrites.js';

function populatedSession() {
  const session = new SyncSession({ treeId: 'tree', registry: null, store: { save: async () => {} } });
  const nodes = Array.from({ length: 3000 }, (_, index) => ({
    id: `n${index}`, createdAt: '5:0:server', label: `Node ${index}`, labelAt: '5:0:server',
    description: 'd'.repeat(40), descriptionAt: '5:0:server', color: 'sky', colorAt: '5:0:server',
  }));
  session.lattice.join({ nodes, edges: [], kinds: [] });
  session.confirmedStructure.join({ nodes, edges: [], kinds: [] });
  for (let index = 0; index < 12; index += 1) {
    const writes = { nodes: [{ id: `n${index}`, label: 'Local', labelAt: `${10 + index}:0:r_local` }], edges: [], kinds: [] };
    session.lattice.join(writes);
    session.inFlight.set(`frame-${index}`, writes);
  }
  return session;
}

test('status serializes the 3000-node confirmed bank once with 12 frames in flight', (t) => {
  const session = populatedSession();
  let reads = 0;
  const confirmed = session.confirmedStructure.toFrame();
  const nodes = new Proxy(confirmed.nodes, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  t.mock.method(session.confirmedStructure, 'toFrame', () => ({ ...confirmed, nodes }));
  const status = session.statusSnapshot();
  assert.deepEqual({ pending: status.structurePending, inFlight: status.structureInFlight, scans: reads }, {
    pending: 12, inFlight: 12, scans: 1,
  });
});

test('status on 3000 nodes and 12 frames stays within twice the precomputed-stamp reference cost', () => {
  const session = populatedSession();
  const reference = () => {
    const confirmed = writeStamps(session.confirmedStructure.toFrame());
    const pending = (frame) => pendingRecordCount(unconfirmedStamps(writeStamps(frame), confirmed));
    return { pending: pending(session.lattice.toFrame()),
      inFlight: [...session.inFlight.values()].filter((frame) => pending(frame) > 0).length };
  };
  for (let warmup = 0; warmup < 3; warmup += 1) { reference(); session.statusSnapshot(); }
  const referenceTimes = [];
  const snapshotTimes = [];
  for (let run = 0; run < 7; run += 1) {
    let start = performance.now();
    assert.deepEqual(reference(), { pending: 12, inFlight: 12 });
    referenceTimes.push(performance.now() - start);
    start = performance.now();
    const status = session.statusSnapshot();
    assert.deepEqual({ pending: status.structurePending, inFlight: status.structureInFlight }, { pending: 12, inFlight: 12 });
    snapshotTimes.push(performance.now() - start);
  }
  referenceTimes.sort((a, b) => a - b);
  snapshotTimes.sort((a, b) => a - b);
  assert.ok(snapshotTimes[3] <= referenceTimes[3] * 2 + 2,
    `snapshot median ${snapshotTimes[3].toFixed(1)} ms; reference median ${referenceTimes[3].toFixed(1)} ms`);
});
