// The shared browser — JOURNAL-1, driven end to end with the real PageStore, the real PageCache and
// one in-memory localStorage, exactly as the audit's repro drove it against a live backend.
//
// What used to happen on a family laptop, a kiosk, or any account switch: every page this browser
// had read or written lived under ONE key with no owner in it, so after A signed out an anonymous
// visitor read A's journal; when B signed in, A's pages were drawn as B's; and B's first keystroke
// PUT A's private prose into B's account on the server, permanently. The silent variant needed no
// keystroke at all — A's unsent page was drained into B's account by B's sign-in.
//
// The fix is a key, not a filter: the device tier is opened under the arriving account's own scope
// (pageCache.js), so the previous account's bytes are never read. That is why the cases below
// include a browser where NOTHING was ever cleared — a crashed tab, a killed browser, a cache
// written before the fix shipped — because those are the ones a sign-out hook does not reach.
//
// The two things that must NOT regress are here too: anonymous writing is still CLAIMED by whoever
// signs in (the anonymous-first door's whole promise), and a person who signs back in still finds
// the page they wrote offline.

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

// The backend, as far as this test needs it: pages per account, resolved by stamp the way
// backend/products/journal/domain/Page.h resolves them, and reached through whichever session the
// browser currently holds — one api object whose answers change when the account does, which is
// what a cookie is.
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

// One tab, one person leaving and another arriving — the ordinary account switch the finding needs.
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

  // And the moment B writes, only B's words go up — the cross-tenant write that made this High.
  store.type('B’s first evening');
  await store.persist();

  assert.equal(backend.bodyOn(B, TODAY), 'B’s first evening');
  assert.deepEqual(backend.days(B), [TODAY], 'nothing of A’s day was ever PUT into B’s account');
  assert.equal(backend.bodyOn(A, TODAY), 'A’s words for today', 'and A’s own page is untouched');

  // Search and the year zoom read the device tier as much as the canvas does — the same leak, one
  // room over, and B's ⌘K corpus must be as empty of A as B's canvas is.
  const read = await corpus({ api: backend.api, account: B, cache: new PageCache(B, storage) });
  assert.deepEqual(read.pages.map((page) => page.body), ['B’s first evening']);
  assert.equal(read.source, 'account');
});

// The hook-less case, and the reason the fix is a key rather than a sign-out handler: this browser
// never signed anybody out. The tab crashed, or the machine was closed, and the next thing that
// happens is B opening the journal on a fresh store over the same disk.
test('a browser that never ran a sign-out still shows B nothing of A’s', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();

  const aTab = openStore(storage, backend);
  await signInAs(aTab, backend, A);
  aTab.type('A’s page, and the tab was killed right after');
  await aTab.persist();

  const bTab = openStore(storage, backend);       // a new tab, nothing cleared, nothing forgotten
  backend.signIn(B);
  await bTab.connect(B);

  assert.deepEqual(bTab.snapshot.history, []);
  assert.equal(bTab.snapshot.body, '');
  assert.deepEqual(backend.days(B), []);
});

// The silent variant the verifier found: A wrote while the account could not be read, so the page
// is OWED and unsent. B's sign-in used to drain that queue into B's account — no keystroke from B,
// and A never received their own page.
test('A’s unsent page is never drained into B’s account, and is still A’s when A returns', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();

  const store = openStore(storage, backend);
  await signInAs(store, backend, A);
  // The wire dies before A types: the day is unread, so the words are HELD rather than stamped.
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

  // …and A gets it back, because their scope kept it: sign-out ends the session, not the writing.
  await signOut(store, backend);
  await signInAs(store, backend, A);
  assert.equal(backend.bodyOn(A, TODAY), 'the thing I could not say out loud');
  assert.equal(store.snapshot.body, 'the thing I could not say out loud');
});

// The feature that must survive the fix: words written with nobody signed in belong to the person
// who signs in here. They are claimed, joined onto whatever the account already holds, and the
// anonymous scope is emptied so the NEXT person to sign in does not claim them a second time.
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

// Every browser that ran journal before this change holds one unscoped blob, and the first cut of
// this fix moved its unsent pages into the ANONYMOUS scope — which is the one scope the next person
// to sign in may claim. A reviewer drove that in a real browser and got A's diary onto B's canvas
// and into B's account through the migration alone, no keystroke by B: the migration WAS the
// finding. "Unsent" says nothing about who wrote it — a page written offline while signed in is
// unsent too. So the unsent pages are quarantined under a key no scope opens, and wait for a person.
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

// The reviewer's reproduction, as a case: B signs in on a browser that has never run the new code,
// opens the journal, and touches nothing.
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

// The other half of "losing nobody's words": a person can say the pages are theirs, and only then
// do they move — joined onto that account's own days, never over them.
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

// The shell's half of the contract, product side. The scope key already decides what is READABLE;
// this is what clears the canvas the departing account is looking at.
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

// The first cut of this fix threw away the queued save on every account change, on the grounds that
// the arriving account’s session must not send it. The session must not — the DEVICE must, and it
// is a different thing: measured, that cost up to SAVE_DEBOUNCE (800 ms) of somebody’s typing on
// every sign-out, and left {"body":""} in their own scope. The words land where they were typed,
// stay owed, and go up when that person comes back.
test('the last words typed before a sign-out are kept — in the scope they were typed under, unsent', async () => {
  const storage = memoryStorage();
  const backend = fakeBackend();
  const store = openStore(storage, backend);

  await signInAs(store, backend, A);
  store.type('the sentence I was still typing');     // the debounce has not fired: savePending
  assert.equal(store.savePending, true);

  await signOut(store, backend);

  assert.equal(new PageCache(A, storage).page(TODAY).body, 'the sentence I was still typing');
  assert.deepEqual(
    new PageCache(A, storage).owed().map((entry) => entry.page.body),
    ['the sentence I was still typing'],
    'kept owed rather than sent — the only session left belongs to somebody else',
  );
  assert.deepEqual(backend.days(A), [], 'nothing went up with nobody signed in');

  // Somebody else arrives first, and still gets none of it.
  await signInAs(store, backend, B);
  assert.equal(store.snapshot.body, '');
  assert.deepEqual(backend.days(B), []);

  // And when A comes back, their own sentence goes up with their own session.
  await signOut(store, backend);
  await signInAs(store, backend, A);
  assert.equal(backend.bodyOn(A, TODAY), 'the sentence I was still typing');
  assert.equal(store.snapshot.body, 'the sentence I was still typing');
});
