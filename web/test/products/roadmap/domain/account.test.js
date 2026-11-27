import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead } from '../../../../src/products/roadmap/domain/reads.js';

test('Board uses effective opening dates and keeps unread account knowledge distinct', () => {
  const account = new RoadmapAccount([
    new RoadmapTree({ id: 'A', nodes: [{ id: 'opening' }, { id: 'ordinary' }], pointers: [{ node: 'opening', present: true, opens: 'B' }],
      marks: [{ node: 'opening', status: 'complete', outOfOrder: false, recordedAt: 9999, deviceAt: 9 },
        { node: 'ordinary', status: 'complete', outOfOrder: false, recordedAt: 1, deviceAt: 2 }] }),
    new RoadmapTree({ id: 'B', nodes: [{ id: 'b' }], marks: [{ node: 'b', status: 'complete', outOfOrder: false, recordedAt: 20, deviceAt: 10 }] }),
    new RoadmapTree({ id: 'unread', read: 'unread' }),
  ]);
  assert.deepEqual(new BoardRead(account.graph('A')).result(), {
    overall: { done: 2, total: 2 }, sort: 'roadmap', branch: null, recovery: null,
    columns: [
      { name: 'locked', count: 0, ids: [], shown: [], folded: false },
      { name: 'upNext', count: 0, ids: [], shown: [], folded: false },
      { name: 'done', count: 2, ids: ['ordinary', 'opening'], shown: ['ordinary', 'opening'], folded: false },
    ],
    cards: [
      { id: 'opening', column: 'done', needs: null, unlocks: null, unlockCount: 0 },
      { id: 'ordinary', column: 'done', needs: null, unlocks: null, unlockCount: 0 },
    ],
    revealing: null,
  });
  assert.equal(account.progress('unread'), null);
  assert.equal(account.graph('unread'), null);
  assert.equal(account.counts('unread'), null);
  assert.equal(account.graph('unknown'), null);
});
