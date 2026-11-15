import test from 'node:test';
import assert from 'node:assert/strict';

import { DISCARD_HOLD_MS, TalkStore } from '../../../../src/products/journal/talk/talkStore.js';

// A page that records who listens for `beforeunload`, timers the test moves, and takes that count their releases.
function tab() {
  const listening = new Set();
  const target = {
    addEventListener: (type, listener) => { if (type === 'beforeunload') listening.add(listener); },
    removeEventListener: (type, listener) => { if (type === 'beforeunload') listening.delete(listener); },
  };
  const pending = new Map();
  let next = 0;
  const timers = {
    setTimeout: (run) => { next += 1; pending.set(next, run); return next; },
    clearTimeout: (id) => pending.delete(id),
  };
  const store = new TalkStore({ target, timers });
  return {
    store,
    guarded: () => listening.size === 1,
    elapse: () => { const runs = [...pending.values()]; pending.clear(); runs.forEach((run) => run()); },
  };
}
const take = (name) => ({ name, released: 0, release() { this.released += 1; } });
const refusal = (until = null) => ({ until, blocks: (now) => until !== null && now < until });

test('a refused take outlives the room: it is kept, guarded from leaving, and its face is told once', () => {
  const { store, guarded } = tab();
  const kept = take('kept');
  const face = refusal();

  const ticket = store.begin();
  assert.equal(guarded(), true, 'a take with the server holds the page');
  store.kept(ticket, kept, face);

  const shown = store.snapshot().face;
  assert.deepEqual({ ...store.snapshot(), face: null }, { sending: false, take: kept, face: null, discarded: null, signInNeeded: false });
  assert.deepEqual(shown, { refusal: face, moment: 'take', announced: false });
  assert.equal(guarded(), true);
  assert.deepEqual([store.announce(shown), store.announce(shown), store.announce(store.snapshot().face)], [true, false, false]);
});

test('a transcript that lands while the room is away is written when it comes back, and the take it was is let go', () => {
  const { store, guarded } = tab();
  const kept = take('kept');
  store.kept(store.begin(), kept, refusal());
  const written = [];

  assert.equal(store.written(store.begin(), 'rain all morning'), true);
  assert.equal(kept.released, 1);
  assert.equal(guarded(), true, 'words not yet in today still hold the page');
  const detach = store.attach((text) => written.push(text));

  assert.deepEqual(written, ['rain all morning']);
  assert.equal(guarded(), false);
  assert.equal(store.written(store.begin(), 'and the light came back'), true);
  detach();
  assert.deepEqual(written, ['rain all morning', 'and the light came back']);
  assert.deepEqual(store.snapshot(), { sending: false, take: null, face: null, discarded: null, signInNeeded: false });
});

test('× holds the take for Undo, lets it go when the hold ends, and a sheet closing ends the hold early', () => {
  const { store, guarded, elapse } = tab();
  const kept = take('kept');
  store.kept(store.begin(), kept, refusal());

  store.discard();
  assert.deepEqual([store.snapshot().take, store.snapshot().discarded, guarded()], [null, kept, false]);
  store.undo();
  assert.deepEqual([store.snapshot().take, store.snapshot().discarded, kept.released], [kept, null, 0]);
  store.discard();
  elapse();
  assert.deepEqual([store.snapshot().discarded, kept.released], [null, 1]);
  assert.equal(DISCARD_HOLD_MS, 6000);

  const second = take('second');
  store.kept(store.begin(), second, refusal());
  store.discard();
  store.dismiss();
  assert.deepEqual([store.snapshot().discarded, store.snapshot().face, second.released], [null, null, 1]);
});

test('an account change forgets everything the tab held, and an answer that lands after it belongs to no one', () => {
  const { store, guarded } = tab();
  const kept = take('kept');
  const until = Date.now() + 60_000;
  store.kept(store.begin(), kept, refusal(until));
  assert.equal(store.blocking(Date.now()).until, until);
  const late = store.begin();
  const travelling = take('travelling');
  const written = [];
  store.attach((text) => written.push(text));

  store.forget();
  store.kept(late, travelling, refusal());
  assert.equal(store.written(late, 'words for the last account'), false);

  assert.deepEqual(store.snapshot(), { sending: false, take: null, face: null, discarded: null, signInNeeded: false });
  assert.deepEqual([kept.released, travelling.released, written, store.blocking(Date.now()), guarded()], [1, 1, [], null, false]);
});
