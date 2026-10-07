import test from 'node:test';
import assert from 'node:assert/strict';

import { syncSession } from '../../../src/platform/sync/session.js';
import { corpus } from '../../../src/products/journal/pages.js';
import { registry } from '../../../src/platform/sync/schema.js';

// The session holds `state` for this test alone.
function holding(t, state) {
  const previous = Object.fromEntries(Object.keys(state).map((key) => [key, syncSession[key]]));
  t.after(() => Object.assign(syncSession, previous));
  Object.assign(syncSession, state);
}

// The corpus is the replica's written pages, read on the device: no request, and only for the account it holds.
test('the corpus reads the replica for its own account, and makes no REST request', (t) => {
  const snapshot = { drawn: [
    { t: 'page', id: '2026-08-04', x: { body: 'better' }, f: { mood: [0], energy: [null], source: ['typed'] } },
    { t: 'page', id: '2026-08-05', x: { body: '' }, f: { mood: [null], energy: [null], source: ['typed'] } },
  ], notices: [], firstPullComplete: true };
  snapshot.stored = snapshot.drawn;
  const engine = { registry, now: () => Date.parse('2026-08-05T12:00:00Z'), activeReplica: () => 'replica',
    readMetadata: () => ({ devices: {}, confirmed: new Map(), firstPullComplete: snapshot.firstPullComplete,
      commands: [], actor: 'writer', isAnonymous: false, checkpoint: { epoch: null, cleanSeq: null } }),
    observe: () => ({ getSnapshot: () => snapshot }), device: { activeReplica: {
    meta: { state: 'bound', account: 'A', serverOffsetMs: 0 }, deviceRows: () => ({}), confirmedRow: () => null,
  } } };
  holding(t, { engine, snapshot: { ...syncSession.snapshot, engine, ready: true } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('local pages used REST'));

  assert.deepEqual(corpus({ account: 'A' }), { source: 'account', pages: [
    { day: '2026-08-04', body: 'better', mood: 0, energy: null, source: 'typed', updatedAt: undefined },
  ] });
  assert.deepEqual(corpus({ account: 'B' }), { pages: [], source: 'failed' }, 'another account’s pages are not this one’s');
  snapshot.firstPullComplete = false;
  assert.equal(corpus({ account: 'A' }).source, 'failed', 'an account not yet read says so');
});

test('the corpus is empty and failed before the engine is ready', (t) => {
  holding(t, { snapshot: { ...syncSession.snapshot, ready: false } });
  assert.deepEqual(corpus({ account: 'A' }), { pages: [], source: 'failed' });
});
