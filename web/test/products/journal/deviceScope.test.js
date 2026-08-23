import test from 'node:test';
import assert from 'node:assert/strict';

import { PageCache, dropUnclaimedPages, keyForScope, unclaimedPages } from '../../../src/products/journal/pageCache.js';
import { PageStore, corpus, holdStore, restoreUnclaimedPages } from '../../../src/products/journal/pageStore.js';
import { journalRoutes } from '../../../src/products/journal/routes.js';

const TODAY = '2026-08-07';
const YESTERDAY = '2026-08-06';
const A = 'user-a';
const B = 'user-b';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function fakeBackend() {
  const accounts = new Map();
  const pagesOf = (account) => {
    if (!accounts.has(account)) accounts.set(account, new Map());
    return accounts.get(account);
  };
  const session = { account: null };
  const api = {
    async range(from, to) {
      if (!session.account) throw new Error('401');
      return [...pagesOf(session.account).values()]
        .filter((page) => page.day >= from && page.day <= to)
        .sort((left, right) => (left.day < right.day ? -1 : 1));
    },
    async page(day) {
      if (!session.account) throw new Error('401');
      return pagesOf(session.account).get(day) ?? null;
    },
    async allPages() {
      if (!session.account) throw new Error('401');
      return [...pagesOf(session.account).values()];
    },
    async putPage(day, body) {
      if (!session.account) throw new Error('401');
      const held = pagesOf(session.account).get(day) ?? null;
      const incoming = { day, ...body };
      const winner = held && held.stamp > incoming.stamp ? held : incoming;
      pagesOf(session.account).set(day, winner);
      return winner;
    },
  };
  return {
    api,
    session,
    signIn(account) { session.account = account; },
    signOut() { session.account = null; },
    bodyOn(account, day) { return pagesOf(account).get(day)?.body ?? null; },
    days(account) { return [...pagesOf(account).keys()].sort(); },
  };
}

function openStore(storage, backend) {
  let minted = 0;
  return new PageStore({
    openCache: (account) => new PageCache(account, storage),
    api: backend.api,
    today: TODAY,
    mint: () => { minted += 1; return `${2000 + minted}:0:web`; },
    setTimer: () => null,
    clearTimer: () => {},
  });
}

async function signInAs(store, backend, account) {
  backend.signIn(account);
  await store.connect(account);
}

async function signOut(store, backend) {
  backend.signOut();
  await store.connect(null);
}

test('A signs out, and nothing of A’s journal is left on the canvas for the next visitor', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  backend.signIn(A);
  await backend.api.putPage(YESTERDAY, {
    body: 'A private thought: my therapist said I should leave him.',
    mood: null, energy: null, source: 'typed', stamp: '100:0:phone',
  });

  const store = openStore(storage, backend);
  await signInAs(store, backend, A);
  store.type('and today I nearly did');
  await store.persist();
  assert.equal(store.snapshot.history[0].body, 'A private thought: my therapist said I should leave him.');

  await signOut(store, backend);

  assert.deepEqual(store.snapshot.history, []);
  assert.equal(store.snapshot.body, '');
  assert.equal(store.snapshot.mood, null);
});

test('B signs in on the same browser and reads a journal of their own — canvas, draft and corpus', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  backend.signIn(A);
  await backend.api.putPage(YESTERDAY, {
    body: 'A private thought: my therapist said I should leave him.',
    mood: null, energy: null, source: 'typed', stamp: '100:0:phone',
  });

  const store = openStore(storage, backend);
  await signInAs(store, backend, A);
  store.type('A’s words for today');
  await store.persist();
  await signOut(store, backend);
  await signInAs(store, backend, B);

  assert.deepEqual(store.snapshot.history, [], 'B’s canvas holds none of A’s days');
  assert.equal(store.snapshot.body, '', 'B’s composer is empty, not pre-filled with A’s page');

  store.type('B’s first evening');
  await store.persist();

  assert.equal(backend.bodyOn(B, TODAY), 'B’s first evening');
  assert.deepEqual(backend.days(B), [TODAY], 'nothing of A’s day was ever PUT into B’s account');
  assert.equal(backend.bodyOn(A, TODAY), 'A’s words for today', 'and A’s own page is untouched');

  const read = await corpus({ api: backend.api, account: B, cache: new PageCache(B, storage) });
  assert.deepEqual(read.pages.map((page) => page.body), ['B’s first evening']);
  assert.equal(read.source, 'account');
});

test('a browser that never ran a sign-out still shows B nothing of A’s', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();

  const aTab = openStore(storage, backend);
  await signInAs(aTab, backend, A);
  aTab.type('A’s page, and the tab was killed right after');
  await aTab.persist();

  const bTab = openStore(storage, backend);
  backend.signIn(B);
  await bTab.connect(B);

  assert.deepEqual(bTab.snapshot.history, []);
  assert.equal(bTab.snapshot.body, '');
  assert.deepEqual(backend.days(B), []);
});

test('A’s unsent page is never drained into B’s account, and is still A’s when A returns', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();

  const store = openStore(storage, backend);
  await signInAs(store, backend, A);
  const dead = () => { throw new Error('offline'); };
  const live = { range: backend.api.range, page: backend.api.page, putPage: backend.api.putPage };
  backend.api.range = dead;
  backend.api.page = dead;
  backend.api.putPage = dead;
  await store.connect(null);
  await signInAs(store, backend, A);
  store.type('the thing I could not say out loud');
  await store.persist();
  assert.deepEqual(store.cache.owed().map((entry) => entry.page.body), ['the thing I could not say out loud']);

  Object.assign(backend.api, live);
  await signOut(store, backend);
  await signInAs(store, backend, B);

  assert.deepEqual(backend.days(B), [], 'B’s sign-in drained nothing of A’s into B’s account');
  assert.equal(store.snapshot.body, '');

  await signOut(store, backend);
  await signInAs(store, backend, A);
  assert.equal(backend.bodyOn(A, TODAY), 'the thing I could not say out loud');
  assert.equal(store.snapshot.body, 'the thing I could not say out loud');
});

test('anonymous writing is still claimed on sign-in — and claimed exactly once', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  backend.signIn(B);
  await backend.api.putPage(TODAY, {
    body: 'B wrote from the phone this morning',
    mood: null, energy: null, source: 'typed', stamp: '100:0:phone',
  });
  backend.signOut();

  const store = openStore(storage, backend);
  await store.connect(null);
  store.type('written before anyone signed in');
  await store.persist();
  assert.equal(store.snapshot.saveState, 'device');
  assert.notEqual(storage.getItem(keyForScope(null)), null);

  await signInAs(store, backend, B);

  assert.equal(
    backend.bodyOn(B, TODAY),
    'B wrote from the phone this morning\n\nwritten before anyone signed in',
    'the claim is additive — B’s own page is joined, never replaced',
  );
  assert.equal(storage.getItem(keyForScope(null)), null, 'the anonymous scope is emptied by the claim');

  await signOut(store, backend);
  await signInAs(store, backend, A);
  assert.deepEqual(backend.days(A), [], 'and A, signing in after, claims nothing that was already claimed');
});

test('the legacy unscoped store is quarantined: unsent work waits, cached pages are dropped', () => {
  const storage = memoryStorage();
  storage.setItem('wm.journal.pages', JSON.stringify({
    [YESTERDAY]: {
      page: { day: YESTERDAY, body: 'read from some account\u2019s window', mood: null, energy: null, source: 'typed', stamp: '100:0:a' },
      needsPush: false,
      read: true,
    },
    [TODAY]: {
      page: { day: TODAY, body: 'A UNSENT DIARY, WRITTEN ON A PLANE', mood: 3, energy: null, source: 'typed', stamp: '200:0:a' },
      needsPush: true,
      read: true,
    },
  }));

  const anon = new PageCache(null, storage);

  assert.equal(storage.getItem('wm.journal.pages'), null, 'the unowned key is gone for good');
  assert.deepEqual(anon.pages(), [], 'nothing was moved into the scope a sign-in claims');
  assert.deepEqual(new PageCache(A, storage).pages(), [], 'and no account inherits the unowned blob');

  const waiting = unclaimedPages(storage);
  assert.deepEqual(waiting.map((page) => page.day), [TODAY], 'only the unsent day survived');
  assert.equal(waiting[0].body, 'A UNSENT DIARY, WRITTEN ON A PLANE');
  assert.equal(waiting[0].stamp, '', 'and it waits unstamped, so it can only ever JOIN a page');
});

test('B signs in through the migration and the quarantined page reaches neither B\u2019s canvas nor B\u2019s account', async () => {
  const storage = memoryStorage();
  storage.setItem('wm.journal.pages', JSON.stringify({
    [YESTERDAY]: {
      page: { day: YESTERDAY, body: 'A UNSENT DIARY, WRITTEN ON A PLANE', mood: null, energy: null, source: 'typed', stamp: '200:0:a' },
      needsPush: true,
      read: true,
    },
  }));

  const backend = fakeBackend();
  const store = openStore(storage, backend);
  await signInAs(store, backend, B);

  assert.deepEqual(store.snapshot.history, [], 'B\u2019s canvas paints none of it');
  assert.equal(store.snapshot.body, '');
  assert.deepEqual(backend.days(B), [], 'and no PUT carried it into B\u2019s account');
  assert.deepEqual(unclaimedPages(storage).map((page) => page.day), [YESTERDAY], 'it is still waiting');
});

test('a signed-in person restores the quarantined pages by hand, and they go up as theirs', async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;                 // the restore reads the device tier the way the browser does
  storage.setItem('wm.journal.pages', JSON.stringify({
    [YESTERDAY]: {
      page: { day: YESTERDAY, body: 'the page I wrote on a plane', mood: null, energy: null, source: 'typed', stamp: '200:0:a' },
      needsPush: true,
      read: false,
    },
  }));

  const backend = fakeBackend();
  backend.signIn(A);
  await backend.api.putPage(YESTERDAY, {
    body: 'what A already had for that day',
    mood: null, energy: null, source: 'typed', stamp: '100:0:phone',
  });

  const store = openStore(storage, backend);
  const release = holdStore(store);
  await signInAs(store, backend, A);
  assert.deepEqual(store.snapshot.history.map((day) => day.body), ['what A already had for that day']);

  const taken = await restoreUnclaimedPages(A);

  assert.equal(taken, 1);
  assert.equal(
    backend.bodyOn(A, YESTERDAY),
    'what A already had for that day\n\nthe page I wrote on a plane',
    'restored pages JOIN the account\u2019s own day rather than replacing it',
  );
  assert.deepEqual(unclaimedPages(storage), [], 'and the quarantine is empty once they landed');

  release();
  delete globalThis.localStorage;
});

test('a ghost cannot restore them, and a discard empties the quarantine', async () => {
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  storage.setItem('wm.journal.pages', JSON.stringify({
    [TODAY]: {
      page: { day: TODAY, body: 'nobody can prove this is theirs', mood: null, energy: null, source: 'typed', stamp: '' },
      needsPush: true,
      read: false,
    },
  }));
  new PageCache(null, storage);                      // the open that retires the legacy key

  assert.equal(await restoreUnclaimedPages(null), 0, 'a ghost may not adopt what nobody could attribute');
  assert.equal(unclaimedPages(storage).length, 1);

  dropUnclaimedPages(storage);
  assert.deepEqual(unclaimedPages(storage), []);
  delete globalThis.localStorage;
});

test('the retirement runs once, and a device that refuses the write keeps the unsent words', () => {
  const blob = JSON.stringify({
    [TODAY]: {
      page: { day: TODAY, body: 'unsent', mood: null, energy: null, source: 'typed', stamp: '200:0:a' },
      needsPush: true,
      read: false,
    },
  });
  const refusing = {
    getItem: (key) => (key === 'wm.journal.pages' ? blob : null),
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('quota'); },
  };

  assert.deepEqual(new PageCache(null, refusing).pages(), [], 'nothing was moved, so nothing is read');
  assert.equal(refusing.getItem('wm.journal.pages'), blob, 'the legacy key stays, and the next open tries again');
});

test('forgetDevice drops the departing account’s canvas, and leaves their pages on disk', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  const store = openStore(storage, backend);
  const release = holdStore(store);

  await signInAs(store, backend, A);
  store.type('A is looking at this right now');
  await store.persist();
  assert.equal(store.snapshot.body, 'A is looking at this right now');

  journalRoutes.forgetDevice({ previous: A, next: B });

  assert.equal(store.snapshot.body, '', 'the draft on screen goes with the account');
  assert.deepEqual(store.snapshot.history, []);
  assert.equal(store.scope, null, 'the store falls back to the anonymous scope');
  assert.notEqual(storage.getItem(keyForScope(A)), null, 'A’s own pages stay under A’s own key');

  release();
});

test('the last words typed before a sign-out are kept — in the scope they were typed under, unsent', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  const store = openStore(storage, backend);

  await signInAs(store, backend, A);
  store.type('the sentence I was still typing');
  assert.equal(store.savePending, true);

  await signOut(store, backend);

  assert.equal(new PageCache(A, storage).page(TODAY).body, 'the sentence I was still typing');
  assert.deepEqual(
    new PageCache(A, storage).owed().map((entry) => entry.page.body),
    ['the sentence I was still typing'],
    'kept owed rather than sent — the only session left belongs to somebody else',
  );
  assert.deepEqual(backend.days(A), [], 'nothing went up with nobody signed in');

  await signInAs(store, backend, B);
  assert.equal(store.snapshot.body, '');
  assert.deepEqual(backend.days(B), []);

  await signOut(store, backend);
  await signInAs(store, backend, A);
  assert.equal(backend.bodyOn(A, TODAY), 'the sentence I was still typing');
  assert.equal(store.snapshot.body, 'the sentence I was still typing');
});
