// The canvas's data, driven for real. Journal-web used to lose writing two ways, and one of them
// destroyed prose that already existed — so these are not shape tests, they are the failures:
//
//   · a returning writer, offline, saw a VIRGIN CANVAS and the first-run placeholder, because the
//     window read's catch only cleared `loading`. A read that failed is not an empty account.
//   · if they then typed, persist() minted a fresh stamp and PUT it, and
//     backend/products/journal/domain/Page.h resolves two writers on the greater stamp — so this
//     morning's real page was silently replaced. THE TEST THAT MATTERS MOST here is the one that
//     asserts nothing is sent at all.
//   · a signed-out visitor's first page was simply gone on reload: no cache of any kind, a PUT to a
//     401, and a 4-second retry loop forever.
//
// And the two ordering rules, both copied from the phone rather than invented: the words land on
// the device BEFORE the network, and a reply is a receipt for ONE write and never for every write.
//
// The store is driven directly, with a fake cache storage, a fake api and fake timers — no React
// and no DOM, because none of the rules above are about either.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PageCache } from '../../../src/products/journal/pageCache.js';
import { BEGINNING, PageStore, corpus, joinBodies, joinCorpus, span } from '../../../src/products/journal/pageStore.js';

const TODAY = '2026-08-07';
const KEY = 'wm.journal.pages';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// Answers are functions so a test can flip one mid-run — which is exactly what "the signal came
// back" is.
function fakeApi() {
  const calls = { range: [], page: [], put: [], all: 0 };
  const api = {
    calls,
    onRange: () => [],
    onPage: () => null,
    onAll: () => [],
    onPut: (day, body) => ({ day, ...body, updatedAt: 1 }),
    async range(from, to) { calls.range.push({ from, to }); return api.onRange(from, to); },
    async page(day) { calls.page.push(day); return api.onPage(day); },
    async allPages() { calls.all += 1; return api.onAll(); },
    async putPage(day, body) { calls.put.push({ day, body }); return api.onPut(day, body); },
  };
  return api;
}

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimer(fn) { const id = next; next += 1; pending.set(id, fn); return id; },
    clearTimer(id) { pending.delete(id); },
    async run() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) await fn();
    },
  };
}

function storeOn(storage, api, { today = TODAY } = {}) {
  const timers = fakeTimers();
  let minted = 0;
  const store = new PageStore({
    cache: new PageCache(storage, KEY),
    api,
    today,
    mint: () => { minted += 1; return `${1000 + minted}:0:web`; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { store, timers, mintCount: () => minted };
}

function wirePage(day, body, stamp, extra = {}) {
  return { day, body, mood: 0, energy: 0, source: 'typed', stamp, updatedAt: 1, ...extra };
}

// ── The overwrite ────────────────────────────────────────────────────────────────────────────

test('a failed window read does NOT read as a first run', async (t) => {
  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };
  const { store, timers } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.equal(store.snapshot.readState, 'failed');
  assert.equal(store.snapshot.firstRun, false);
  assert.equal(store.snapshot.loading, false);
  assert.equal(timers.pending.size, 1);   // what is owed after a failed read is another read
});

// THE ONE THAT MATTERS MOST. The writer types into a canvas that could not be read; the account's
// real page for today is untouched because nothing goes out at all.
test('a failed window read followed by typing sends NOTHING', async (t) => {
  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };
  const { store, timers, mintCount } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  store.type('written on a plane');
  await timers.run();                     // the debounce fires

  assert.deepEqual(api.calls.put, []);
  assert.equal(mintCount(), 0, 'no stamp may be minted against a page this device has not read');
  assert.equal(store.snapshot.saveState, 'device');
  assert.equal(store.snapshot.firstRun, false);
});

// The whole failure, end to end: the words are held, the signal returns, and what finally goes up
// CONTAINS this morning's page rather than replacing it.
test('when the read finally lands, the held words are JOINED onto the account’s page, never over it', async (t) => {
  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };
  const { store, timers } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  store.type('written on a plane');
  await timers.run();
  assert.deepEqual(api.calls.put, []);

  // The signal comes back. This morning's real page was written from the phone at 09:00.
  const morning = wirePage(TODAY, 'woke up early, wrote before work', '5:0:phone');
  api.onPage = () => morning;
  api.onRange = () => [morning];
  api.onPut = (day, body) => ({ day, ...body, updatedAt: 2 });

  await timers.run();                     // the retry is the whole sync: claim, then read

  assert.deepEqual(api.calls.page, [TODAY], 'the account’s page is READ before a stamp is minted');
  assert.equal(api.calls.put.length, 1);
  assert.equal(api.calls.put[0].body.body, 'woke up early, wrote before work\n\nwritten on a plane');
  assert.equal(api.calls.put[0].body.stamp, '1001:0:web');
  assert.equal(store.snapshot.body, 'woke up early, wrote before work\n\nwritten on a plane');
  assert.deepEqual(store.cache.owed(), []);
});

// A failed read with a warm cache is the returning writer's actual case: two years of pages, a
// plane, and a canvas that must still be their canvas.
test('a failed read still draws what the device holds, and says the account could not be read', async (t) => {
  const storage = memoryStorage();
  const warm = new PageCache(storage, KEY);
  warm.markRead('2026-08-05', { day: '2026-08-05', body: 'a real page', mood: 3, energy: null, source: 'typed', stamp: '1:0:a' });
  warm.markRead('2026-08-06', null);
  warm.flush();

  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };
  const { store } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.equal(store.snapshot.readState, 'failed');
  assert.equal(store.snapshot.firstRun, false);
  assert.deepEqual(store.snapshot.history, [
    { date: '2026-08-05', body: 'a real page', mood: 3, energy: null, written: true },
    { date: '2026-08-06', body: '', mood: null, energy: null, written: false },
  ]);
});

// The one race left in the join: the writer keeps typing while the reconnect is in the air. Their
// newer words are joined onto the recovered page too, by the same rule — never raced against prose
// they never saw, and never duplicated.
test('typing while the join is in flight joins the newer words too, and saves them', async (t) => {
  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };
  const { store, timers } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  store.type('plane words');
  await timers.run();
  assert.deepEqual(api.calls.put, []);

  const morning = wirePage(TODAY, 'this morning’s real page', '5:0:phone');
  api.onPage = () => morning;
  api.onRange = () => [morning];
  let release = null;
  api.onPut = (day, body) => new Promise((resolve) => { release = () => resolve({ day, ...body, updatedAt: 2 }); });

  const reconnect = timers.run();
  for (let turn = 0; turn < 50 && !release; turn += 1) await Promise.resolve();
  assert.ok(release, 'the join’s PUT should be in the air by now');

  store.type('plane words, and more');   // typed while the join's PUT is still in the air
  api.onPut = (day, body) => ({ day, ...body, updatedAt: 3 });
  release();
  await reconnect;

  assert.equal(store.snapshot.body, 'this morning’s real page\n\nplane words, and more');
  const last = api.calls.put[api.calls.put.length - 1];
  assert.equal(last.body.body, 'this morning’s real page\n\nplane words, and more');
  assert.deepEqual(store.cache.owed(), []);
});

// A day the device HAS read may be written over — that is ordinary last-writer-wins, and it is the
// case the fix must not break.
test('a read day is written normally: a stamp is minted and the page goes up', async (t) => {
  const api = fakeApi();
  api.onRange = () => [];
  const { store, timers } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  assert.equal(store.snapshot.readState, 'ready');
  assert.equal(store.snapshot.reach, 'end', 'an empty window is settled all the way back before anything is claimed');
  assert.equal(store.snapshot.firstRun, true, 'an account that read fine and holds nothing IS a first run');

  store.type('the first thing I ever wrote');
  await timers.run();

  assert.equal(api.calls.put.length, 1);
  assert.deepEqual(api.calls.put[0], {
    day: TODAY,
    body: { body: 'the first thing I ever wrote', mood: null, energy: null, source: 'typed', stamp: '1001:0:web' },
  });
  assert.equal(store.snapshot.saveState, 'saved');
  assert.equal(store.snapshot.firstRun, false);
});

// ── Signed out ───────────────────────────────────────────────────────────────────────────────

test('a signed-out write reaches no network, and survives a reload', async (t) => {
  const storage = memoryStorage();
  const api = fakeApi();
  const first = storeOn(storage, api);

  await first.store.connect(false);
  assert.equal(first.store.snapshot.readState, 'device');
  first.store.type('nobody is signed in and this still works');
  await first.timers.run();

  assert.deepEqual(api.calls.put, []);
  assert.deepEqual(api.calls.range, []);
  assert.equal(first.store.snapshot.saveState, 'device');
  first.store.dispose();

  const reopened = storeOn(storage, api);
  t.after(() => reopened.store.dispose());
  await reopened.store.connect(false);

  assert.equal(reopened.store.snapshot.body, 'nobody is signed in and this still works');
  assert.equal(reopened.store.snapshot.firstRun, false);
  assert.equal(reopened.store.snapshot.saveState, 'device');
});

test('a mood tap signed out is held too — the offline story covers both write paths', async (t) => {
  const storage = memoryStorage();
  const api = fakeApi();
  const { store, timers } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(false);
  await store.tap('mood', 4);            // a tap writes immediately — there is nothing to debounce

  assert.deepEqual(api.calls.put, []);
  assert.equal(store.cache.page(TODAY).mood, 4);
  assert.equal(store.snapshot.mood, 4);
  assert.equal(timers.pending.size, 0, 'signed out there is nothing to retry — the device IS the record');

  await store.tap('mood', 4);            // tapping the step you are on clears it
  assert.equal(store.snapshot.mood, null);
  assert.equal(store.cache.page(TODAY).mood, null);
});

// ── The claim ────────────────────────────────────────────────────────────────────────────────

test('signing in claims what is owed, oldest first', async (t) => {
  const storage = memoryStorage();
  const held = new PageCache(storage, KEY);
  held.hold({ day: '2026-08-05', body: 'monday', mood: null, energy: null, source: 'typed' });
  held.hold({ day: '2026-08-06', body: 'tuesday', mood: null, energy: null, source: 'typed' });
  held.hold({ day: TODAY, body: 'today', mood: null, energy: null, source: 'typed' });
  held.flush();

  const api = fakeApi();
  const { store } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.deepEqual(api.calls.put.map((call) => call.day), ['2026-08-05', '2026-08-06', TODAY]);
  assert.deepEqual(api.calls.put.map((call) => call.body.body), ['monday', 'tuesday', 'today']);
  assert.deepEqual(api.calls.page, ['2026-08-05', '2026-08-06', TODAY], 'each unread day is read before it is stamped');
  assert.deepEqual(store.cache.owed(), []);
  assert.equal(store.snapshot.readState, 'ready');
});

test('a claim onto an account that already holds that day joins rather than replaces', async (t) => {
  const storage = memoryStorage();
  const held = new PageCache(storage, KEY);
  held.hold({ day: TODAY, body: 'what I wrote here', mood: 2, energy: null, source: 'typed' });
  held.flush();

  const api = fakeApi();
  api.onPage = (day) => (day === TODAY ? wirePage(TODAY, 'what the account already had', '9:0:phone', { energy: 3 }) : null);
  const { store } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.equal(api.calls.put.length, 1);
  assert.deepEqual(api.calls.put[0].body, {
    body: 'what the account already had\n\nwhat I wrote here',
    mood: 2,          // the writer's own, kept
    energy: 3,        // never set here, so the account's survives
    source: 'typed',
    stamp: '1001:0:web',
  });
});

test('a claim that cannot reach the network stops at the first failure and stays owed', async (t) => {
  const storage = memoryStorage();
  const held = new PageCache(storage, KEY);
  held.hold({ day: '2026-08-05', body: 'monday', mood: null, energy: null, source: 'typed' });
  held.hold({ day: '2026-08-06', body: 'tuesday', mood: null, energy: null, source: 'typed' });
  held.flush();

  const api = fakeApi();
  api.onPut = (day) => { if (day === '2026-08-06') throw new Error('offline'); return wirePage(day, 'monday', '1:0:web'); };
  const { store, timers } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.deepEqual(store.cache.owed().map((entry) => entry.page.day), ['2026-08-06']);
  assert.deepEqual(api.calls.range, [], 'the window read never runs over an undrained backlog');
  assert.equal(store.snapshot.saveState, 'offline');
  assert.equal(timers.pending.size, 1);
});

// ── One receipt per write ────────────────────────────────────────────────────────────────────

test('a reply to an earlier write leaves a newer one still owed', async (t) => {
  const api = fakeApi();
  api.onRange = () => [];
  const { store, timers } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());
  await store.connect(true);

  // Both replies are held open, so the second write is banked while the first is still in the air.
  const gates = [];
  api.onPut = (day, body) => new Promise((resolve) => gates.push(() => resolve({ day, ...body, updatedAt: 2 })));

  store.type('one sentence');
  const first = store.scheduleSave(0);
  store.type('one sentence, and another');
  const second = store.scheduleSave(0);

  gates[0]();                            // only the EARLIER write is acknowledged
  await first;

  assert.deepEqual(store.cache.owed().map((entry) => entry.page.body), ['one sentence, and another']);
  assert.equal(store.cache.page(TODAY).stamp, '1002:0:web');
  assert.equal(store.snapshot.body, 'one sentence, and another', 'a slow reply never overwrites what is still being typed');

  gates[1]();
  await second;
  assert.deepEqual(store.cache.owed(), []);
  assert.deepEqual(api.calls.put.map((call) => call.body.body), ['one sentence', 'one sentence, and another']);
  assert.equal(timers.pending.size, 0);
});

// ── Honesty about where the words are ────────────────────────────────────────────────────────

test('a browser with no room, and no network either, says the words are not saved', async (t) => {
  const refusing = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  };
  const api = fakeApi();
  api.onRange = () => [];
  api.onPut = () => { throw new Error('offline'); };
  const { store, timers } = storeOn(refusing, api);
  t.after(() => store.dispose());

  await store.connect(true);
  store.type('nowhere to put this');
  await timers.run();

  assert.equal(store.snapshot.saveState, 'unsaved');
});

test('a write that the account refused is still on the device, and owed', async (t) => {
  const storage = memoryStorage();
  const api = fakeApi();
  api.onRange = () => [];
  const { store, timers } = storeOn(storage, api);
  t.after(() => store.dispose());

  await store.connect(true);
  api.onPut = () => { throw new Error('offline'); };
  store.type('typed while the wire was down');
  await timers.run();

  assert.equal(store.snapshot.saveState, 'offline');
  assert.deepEqual(store.cache.owed().map((entry) => entry.page.body), ['typed while the wire was down']);
  assert.equal(new PageCache(storage, KEY).page(TODAY).body, 'typed while the wire was down');
});

// ── The timers this store schedules with ─────────────────────────────────────────────────────
//
// Every case above injects its own timers, which is what made this store drivable — and it is also
// how a canvas that could not open in a browser shipped past a green suite. `this.setTimer(…)`
// calls whatever it holds as a METHOD of the store, and a browser's timer functions check their
// receiver: `window.setTimeout` invoked on anything else throws "Illegal invocation". Node's do
// not. The first call to reach one was dispose()'s clear, on React's StrictMode double-invoke, so
// the canvas died at mount into the error boundary — "Something went wrong on this screen."
test('the default timers survive being called as methods, the way a browser demands', async (t) => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const asBrowser = (real) => function receiverChecked(...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return real(...args);
  };
  globalThis.setTimeout = asBrowser(realSet);
  globalThis.clearTimeout = asBrowser(realClear);
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; });

  const api = fakeApi();
  api.onRange = () => { throw new Error('offline'); };   // a failed read schedules a retry
  const store = new PageStore({ cache: new PageCache(memoryStorage(), KEY), api, today: TODAY });

  await store.connect(true);
  store.type('and typing schedules a save');
  store.dispose();                                        // …and leaving clears both

  assert.equal(store.snapshot.readState, 'failed');
  assert.equal(store.snapshot.saveState, 'device');
});

// ── The floor ────────────────────────────────────────────────────────────────────────────────
//
// The top of the canvas is the bottom of the journal, and until 2026-08-07 there was no way down
// it: WINDOW_DAYS is sixty, and the sixty-first day back was reachable only by knowing what to
// search for. The walk has three answers and the difference between two of them is the whole point
// — a read that FAILED must never read as the beginning of somebody's journal.

test('the floor reaches one window deeper per press, and the walk stays open', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => {
    if (from === '2026-06-08') return [wirePage('2026-06-10', 'inside the window', '1:0:a')];
    if (from === '2026-04-10') return [wirePage('2026-05-02', 'a window deeper', '2:0:a')];
    return [];
  };
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  assert.equal(store.snapshot.reach, 'more');
  assert.equal(store.snapshot.history[0].date, '2026-06-10');

  await store.reachBack();

  assert.deepEqual(api.calls.range, [
    { from: '2026-06-08', to: TODAY },
    { from: '2026-04-10', to: '2026-06-09' },
  ]);
  assert.equal(store.snapshot.reach, 'more', 'a window with pages in it settles nothing');
  assert.equal(store.snapshot.history[0].date, '2026-05-02');
  // Reaching back EXTENDS what the device holds, so the canvas is still theirs on the next open.
  assert.equal(store.cache.page('2026-05-02').body, 'a window deeper');
  assert.equal(store.cache.hasRead('2026-05-02'), true);
});

// THE ONE THAT MATTERS. Telling a writer with two years of pages that their journal starts in June
// is the same lie the canvas already refuses to tell about an empty account, told at the other edge.
test('a reach back that FAILED is never the start of the journal', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => {
    if (from === '2026-06-08') return [wirePage('2026-06-10', 'inside the window', '1:0:a')];
    throw new Error('offline');
  };
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  await store.reachBack();

  assert.equal(store.snapshot.reach, 'failed');
  assert.equal(store.snapshot.firstRun, false);
  assert.equal(store.snapshot.history[0].date, '2026-06-10', 'what was already read stays on screen');

  // …and the step is still offered, because the walk was never settled.
  api.onRange = (from) => (from === '2026-04-10' ? [wirePage('2026-05-02', 'still there', '2:0:a')] : []);
  await store.reachBack();

  assert.equal(store.snapshot.reach, 'more');
  assert.equal(store.snapshot.history[0].date, '2026-05-02');
});

// The other half of the same rule: it is the SETTLING read that earns the word "start", so that
// read failing must not settle anything either.
test('a settling read that failed is not the beginning either', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => {
    if (from === '2026-06-08') return [wirePage('2026-06-10', 'inside the window', '1:0:a')];
    if (from === '2026-04-10') return [];              // sixty quiet days
    throw new Error('offline');                        // …and the read that would settle them
  };
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  await store.reachBack();

  assert.deepEqual(api.calls.range, [
    { from: '2026-06-08', to: TODAY },
    { from: '2026-04-10', to: '2026-06-09' },
    { from: BEGINNING, to: '2026-04-09' },
  ]);
  assert.equal(store.snapshot.reach, 'failed');
  assert.equal(store.snapshot.history[0].date, '2026-06-10');
});

test('an empty stretch is settled in the same press, and the start is then said out loud', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => {
    if (from === '2026-06-08') return [wirePage('2026-06-10', 'inside the window', '1:0:a')];
    if (from === '2026-04-10') return [];
    if (from === BEGINNING) return [wirePage('2024-03-12', 'the first page I ever wrote', '0:0:a')];
    return [];
  };
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);
  await store.reachBack();

  assert.deepEqual(api.calls.range, [
    { from: '2026-06-08', to: TODAY },
    { from: '2026-04-10', to: '2026-06-09' },
    { from: BEGINNING, to: '2026-04-09' },
  ]);
  assert.equal(store.snapshot.reach, 'end');
  assert.equal(store.snapshot.history[0].date, '2024-03-12', 'a quiet stretch was hiding the rest of the journal');
  assert.equal(store.snapshot.history[0].body, 'the first page I ever wrote');

  await store.reachBack();
  assert.equal(api.calls.range.length, 3, 'there is nothing older to ask for twice');
});

// A writer who has been away longer than the window used to be handed a virgin canvas and told to
// start anywhere, with years of their own pages one read away.
test('a writer away longer than the window is not a first run', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => (from === BEGINNING ? [wirePage('2026-01-04', 'before I stopped', '1:0:a')] : []);
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.deepEqual(api.calls.range, [
    { from: '2026-06-08', to: TODAY },
    { from: BEGINNING, to: '2026-06-07' },
  ]);
  assert.equal(store.snapshot.firstRun, false);
  assert.equal(store.snapshot.reach, 'end');
  assert.equal(store.snapshot.history[0].date, '2026-01-04');
});

test('an empty window whose settling read failed says nothing about whether the account is new', async (t) => {
  const api = fakeApi();
  api.onRange = (from) => { if (from === BEGINNING) throw new Error('offline'); return []; };
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(true);

  assert.equal(store.snapshot.readState, 'ready', 'the window itself read fine');
  assert.equal(store.snapshot.reach, 'failed');
  assert.equal(store.snapshot.firstRun, false, 'nothing may call this account new');
});

test('signed out there is no account to reach into, and nothing is read', async (t) => {
  const api = fakeApi();
  const { store } = storeOn(memoryStorage(), api);
  t.after(() => store.dispose());

  await store.connect(false);
  await store.reachBack();

  assert.deepEqual(api.calls.range, []);
  assert.equal(store.snapshot.reach, 'more');
  assert.equal(store.snapshot.readState, 'device');
  assert.equal(store.snapshot.firstRun, true, 'signed out, an empty device IS a first run — no read needed');
});

// ── The whole journal ────────────────────────────────────────────────────────────────────────
//
// Search, the year zoom and the nudge read the corpus rather than a window, and all three read the
// ACCOUNT — which was the whole truth until pages began living on this device. A signed-out
// writer's own pages were invisible to their own ⌘K.

test('joinCorpus — the device’s pages are part of the journal, and an owed one wins outright', () => {
  const cache = new PageCache(memoryStorage(), KEY);
  cache.markRead('2026-08-01', { day: '2026-08-01', body: 'read from the account', mood: null, energy: null, source: 'typed', stamp: '5:0:a' });
  cache.markRead('2026-08-02', null);                       // a day nobody wrote
  cache.store({ day: '2026-08-03', body: 'written offline', mood: null, energy: null, source: 'typed', stamp: '9:0:web' }, { needsPush: true, read: true });
  cache.hold({ day: '2026-08-04', body: 'held, and carrying no stamp at all', mood: null, energy: null, source: 'typed' });

  const account = [
    wirePage('2026-08-01', 'read from the account', '5:0:a'),
    wirePage('2026-08-03', 'the account’s older copy', '1:0:a'),
    wirePage('2026-08-04', 'the account’s copy of a day held here', '99:0:a'),
  ];

  assert.deepEqual(joinCorpus(account, cache).map((page) => [page.day, page.body]), [
    ['2026-08-01', 'read from the account'],
    ['2026-08-03', 'written offline'],
    ['2026-08-04', 'held, and carrying no stamp at all'],
  ]);
});

test('corpus — signed out, this device IS the journal, and nothing is asked of the account', async () => {
  const cache = new PageCache(memoryStorage(), KEY);
  cache.hold({ day: '2026-08-06', body: 'nobody is signed in and this is still mine', mood: null, energy: null, source: 'typed' });
  const api = fakeApi();
  api.onAll = () => { throw new Error('401'); };

  assert.deepEqual(await corpus({ api, cache, signedIn: false }), {
    source: 'device',
    pages: [{ day: '2026-08-06', body: 'nobody is signed in and this is still mine', mood: null, energy: null, source: 'typed', stamp: '' }],
  });
  assert.equal(api.calls.all, 0);
});

test('corpus — a corpus that could not be read is not an empty journal', async () => {
  const cache = new PageCache(memoryStorage(), KEY);
  cache.markRead('2026-08-06', { day: '2026-08-06', body: 'on this device', mood: null, energy: null, source: 'typed', stamp: '2:0:a' });
  const api = fakeApi();
  api.onAll = () => { throw new Error('offline'); };

  const read = await corpus({ api, cache, signedIn: true });

  assert.equal(read.source, 'failed');
  assert.deepEqual(read.pages.map((page) => page.day), ['2026-08-06']);
});

test('corpus — the account answered, and this device’s unsent page is in it too', async () => {
  const cache = new PageCache(memoryStorage(), KEY);
  cache.hold({ day: '2026-08-06', body: 'typed on a plane, still owed', mood: null, energy: null, source: 'typed' });
  const api = fakeApi();
  api.onAll = () => [wirePage('2026-07-01', 'an old page', '1:0:a')];

  const read = await corpus({ api, cache, signedIn: true });

  assert.equal(read.source, 'account');
  assert.deepEqual(read.pages.map((page) => [page.day, page.body]), [
    ['2026-07-01', 'an old page'],
    ['2026-08-06', 'typed on a plane, still owed'],
  ]);
});

// ── The pure rules underneath ────────────────────────────────────────────────────────────────

test('joinBodies — nothing anyone wrote is destroyed, and nothing is duplicated', () => {
  assert.equal(joinBodies('', 'mine'), 'mine');
  assert.equal(joinBodies('theirs', ''), 'theirs');
  assert.equal(joinBodies('theirs', 'mine'), 'theirs\n\nmine');
  assert.equal(joinBodies('theirs\n\n', '\n  mine'), 'theirs\n\nmine');
  assert.equal(joinBodies('theirs', 'theirs\n\nmine'), 'theirs\n\nmine');
});

test('span — the inclusive run of days, oldest first, gaps and all', () => {
  assert.deepEqual(span('2026-08-05', '2026-08-07'), ['2026-08-05', '2026-08-06', '2026-08-07']);
  assert.deepEqual(span('2026-08-07', '2026-08-07'), ['2026-08-07']);
});
