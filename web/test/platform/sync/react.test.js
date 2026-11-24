import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { syncSession } from '../../../src/platform/sync/session.js';
import { useSyncNotices, useSyncRecords } from '../../../src/platform/sync/react.js';

const { ReactCurrentDispatcher } = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

// One render of `hook` as React draws it: a store's current snapshot, a memo computed afresh.
function drawn(hook) {
  const outer = ReactCurrentDispatcher.current;
  ReactCurrentDispatcher.current = { useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(), useMemo: (factory) => factory() };
  try { return hook(); } finally { ReactCurrentDispatcher.current = outer; }
}

// The shell has settled account A; the open engine's replica is bound to `bound`, as when another tab signed B in first.
function shellSettledA(t, bound) {
  const held = (snapshot) => ({ subscribe: () => () => {}, getSnapshot: () => snapshot, release() {} });
  const replica = Object.freeze({ state: 'bound', account: bound, binding: `["store","${bound}"]` });
  const records = Object.freeze({ replica: `rp_${bound}`, drawn: [{ t: 'page', id: '2026-11-24', f: { body: `${bound} wrote this` } }],
    stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: true, notices: [], undoOffers: [], firstPullComplete: true });
  const notices = Object.freeze({ replica: `rp_${bound}`, notices: [{ id: `notice:${bound}`, code: 'cap' }] });
  const engine = { observeEngine: () => () => {}, getSnapshot: () => replica, observe: () => held(records), observeNotices: () => held(notices) };
  t.mock.method(syncSession, 'getSnapshot', () => ({ engine, ready: true, signedIn: true, account: 'A', online: true, error: false }));
  return { records, notices };
}

test('a room draws the records and notices of the replica the shell settled, and nothing of another account\'s while the shell catches up', (t) => {
  const own = shellSettledA(t, 'A');
  assert.deepEqual({ records: drawn(() => useSyncRecords('self/journal')), notices: drawn(() => useSyncNotices('journal')) }, own);
  t.mock.restoreAll();
  shellSettledA(t, 'B');
  assert.deepEqual({ records: drawn(() => useSyncRecords('self/journal')), notices: drawn(() => useSyncNotices('journal')) }, {
    records: { replica: null, drawn: [], stored: [], pending: [], outbox: { held: 0, ready: 0, sent: 0, acked: 0 }, loaded: false,
      notices: [], undoOffers: [], firstPullComplete: false },
    notices: { replica: null, notices: [] },
  });
});
