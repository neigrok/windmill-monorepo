// The claim, pinned against the shipped create contract. Four properties are load-bearing:
//   · a 409 the account itself caused (id-retired) is an ANSWER, not a collision — the device lets
//     the tree go, and never re-plants it under a fresh id. This is the bug the product owner hit:
//     a deleted "Learn to sail" came back every boot, wearing a new id, so deleting it never helped;
//   · a 409 that is genuinely somebody else's id (id-taken) still remaps, and the local tree — its
//     registry row, its per-tree blobs, the open route — moves under the fresh id with it;
//   · one retired tree does not doom the rest of the pass; the trees behind it still claim;
//   · an unreachable or signed-out server DOES stop the pass — there is nothing left to ask.
//
// No socket is dialled anywhere below: the retired path throws before the drain, and the claims that
// succeed drain through the live-session seam claimLocalTrees already takes for the open tree.

import test from 'node:test';
import assert from 'node:assert/strict';

import { claimLocalTrees } from '../../../../src/products/roadmap/sync/claimLocalTrees.js';

const BASE = 'http://localhost:8088';
const INDEX = 'windmill:device-trees';
const ME = 'u_owner';

// mintTreeId is crypto.getRandomValues + hex, so one fixed byte pattern names the remap's fresh id
// exactly — and any tree wearing it is a tree the claim planted rather than adopted.
const FRESH_ID = 't_beadbeadbeadbead';
const FRESH_BYTES = [0xbe, 0xad, 0xbe, 0xad, 0xbe, 0xad, 0xbe, 0xad];

const realFetch = globalThis.fetch;
const realWindow = globalThis.window;
const realLocalStorage = globalThis.localStorage;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function browserWith(entries, { hash = '', blobs = {} } = {}) {
  const disk = new Map(Object.entries(blobs));
  disk.set(INDEX, JSON.stringify(entries));
  const events = [];
  const storage = {
    getItem: (key) => (disk.has(key) ? disk.get(key) : null),
    setItem: (key, value) => disk.set(key, value),
    removeItem: (key) => disk.delete(key),
  };
  globalThis.window = {
    localStorage: storage,
    location: { hash },
    dispatchEvent: (event) => { events.push({ type: event.type, detail: event.detail }); return true; },
    // track()'s five-second debounce would hold the runner open and then post to a restored fetch.
    // Telemetry is fire-and-forget by contract, so the timer is allowed to go nowhere.
    setTimeout: () => 0,
  };
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, 'crypto', {
    value: { getRandomValues: (array) => { array.set(FRESH_BYTES); return array; } },
    configurable: true,
  });
  return {
    events,
    index: () => JSON.parse(disk.get(INDEX)),
    blob: (key) => disk.get(key) ?? null,
  };
}

// The claim asks who is arriving before it adopts anything (audit WEB-4), so every scenario has a
// signed-in account behind it. That probe is answered here and deliberately kept out of `calls`:
// the assertions below pin the CLAIM's wire — which trees were planted, and in what order.
function serverThat(...answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url === `${BASE}/v1/me`) return { ok: true, status: 200, json: async () => ({ user: { id: ME } }) };
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
      credentials: init.credentials,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

const plants = (calls) => calls.filter((call) => call.method === 'POST' && call.url === `${BASE}/v1/trees`);
const planted = (treeId) => ({ ok: true, status: 200, json: async () => ({ treeId, existed: false }) });
const conflict = (code, error) => ({ ok: false, status: 409, json: async () => ({ code, error }) });

// The claim's own seam for "this tree is already open": syncTreeUp drains through the live session
// rather than dialling a socket. A session that reports itself drained is a claim that completes.
function openSessionFor(treeId) {
  return {
    treeId,
    phase: 'live',
    forceReconnect() {},
    onDrained(handler) { if (handler) setImmediate(handler); return this; },
    sendProgress() {},
    close() { throw new Error('the claim must never close a session it did not open'); },
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.window = realWindow;
  globalThis.localStorage = realLocalStorage;
  Object.defineProperty(globalThis, 'crypto', realCrypto);
});

// THE REGRESSION. A soft-deleted id used to come back as 409 id-taken — indistinguishable from a
// stranger's tree — so the claim minted a fresh id and planted the deleted roadmap all over again,
// on every single boot. The account's own retired id must cost exactly one POST and end the entry.
test('an id this account retired is let go — no second POST, and the device index forgets it', async () => {
  const browser = browserWith({ t_dead: { title: 'Learn to sail', updatedAt: 20, claimed: false } });
  const calls = serverThat(conflict('id-retired', 'that id names a roadmap you deleted'));

  const result = await claimLocalTrees();

  assert.deepEqual(plants(calls).map((call) => call.body), [{ id: 't_dead', title: 'Learn to sail' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(result, { claimed: 0, pending: 1 });
  assert.deepEqual(browser.index(), {});
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-claim-retired', detail: { treeId: 't_dead' } },
    { type: 'wm-claim-done', detail: { claimed: 0, pending: 1 } },
  ]);
});

// The contrast, and the reason id-retired had to be its own code: a 409 that really is another
// account's id is cryptographically unreachable for an honest mint, and the local tree survives it.
test('an id another account owns still remaps — a fresh id, and everything local moves under it', async () => {
  const browser = browserWith(
    { t_mine: { title: 'Learn to sail', updatedAt: 20, claimed: false } },
    { hash: '#/app/t_mine', blobs: { 'windmill:legend:t_mine': '{"kinds":[]}' } },
  );
  const calls = serverThat(conflict('id-taken', 'that id is taken'), planted(FRESH_ID));

  const result = await claimLocalTrees({ openTreeId: FRESH_ID, openSession: () => openSessionFor(FRESH_ID) });

  assert.deepEqual(plants(calls).map((call) => call.body), [
    { id: 't_mine', title: 'Learn to sail' },
    { id: FRESH_ID, title: 'Learn to sail' },
  ]);
  assert.notEqual(FRESH_ID, 't_mine');
  assert.equal(plants(calls)[1].credentials, 'include');
  assert.deepEqual(result, { claimed: 1, pending: 1 });
  assert.deepEqual(browser.index(), { [FRESH_ID]: { title: 'Learn to sail', updatedAt: 20, claimed: true, owner: ME } });
  // the legend blob stands for everything moveLocalTree carries across: it left the old id and
  // arrived, byte-for-byte, under the new one.
  assert.equal(browser.blob('windmill:legend:t_mine'), null);
  assert.equal(browser.blob(`windmill:legend:${FRESH_ID}`), '{"kinds":[]}');
  assert.equal(globalThis.window.location.hash, `#/app/${FRESH_ID}`);
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-claim-conflict', detail: { treeId: 't_mine', remappedTo: FRESH_ID } },
    { type: 'wm-tree-claimed', detail: { treeId: FRESH_ID } },
    { type: 'wm-claim-done', detail: { claimed: 1, pending: 1 } },
  ]);
});

test('a retired tree ends its own entry and nothing else — the trees behind it still claim', async () => {
  const browser = browserWith({
    t_dead: { title: 'Learn to sail', updatedAt: 20, claimed: false },
    t_live: { title: 'Learn to cook', updatedAt: 10, claimed: false },
  });
  const calls = serverThat(conflict('id-retired', 'that id names a roadmap you deleted'), planted('t_live'));

  const result = await claimLocalTrees({ openTreeId: 't_live', openSession: () => openSessionFor('t_live') });

  assert.deepEqual(plants(calls).map((call) => call.body), [
    { id: 't_dead', title: 'Learn to sail' },
    { id: 't_live', title: 'Learn to cook' },
  ]);
  assert.deepEqual(result, { claimed: 1, pending: 2 });
  assert.deepEqual(browser.index(), { t_live: { title: 'Learn to cook', updatedAt: 10, claimed: true, owner: ME } });
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-claim-retired', detail: { treeId: 't_dead' } },
    { type: 'wm-tree-claimed', detail: { treeId: 't_live' } },
    { type: 'wm-claim-done', detail: { claimed: 1, pending: 2 } },
  ]);
});

test('a dead network stops the pass — the rest is not asked, and nothing is given up', async () => {
  const browser = browserWith({
    t_one: { title: 'Learn to sail', updatedAt: 20, claimed: false },
    t_two: { title: 'Learn to cook', updatedAt: 10, claimed: false },
  });
  const calls = serverThat(new TypeError('failed to fetch'));

  const result = await claimLocalTrees();

  assert.deepEqual(plants(calls).map((call) => call.body), [{ id: 't_one', title: 'Learn to sail' }]);
  assert.deepEqual(result, { claimed: 0, pending: 2 });
  // The rows keep their claim state; the owner stamp is the first-contact attribution the identity
  // probe makes on any row written before entries named an account.
  assert.deepEqual(browser.index(), {
    t_one: { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: ME },
    t_two: { title: 'Learn to cook', updatedAt: 10, claimed: false, owner: ME },
  });
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-claim-done', detail: { claimed: 0, pending: 2 } },
  ]);
});

test('a signed-out server stops the pass too — every tree stays pending for the next one', async () => {
  const browser = browserWith({
    t_one: { title: 'Learn to sail', updatedAt: 20, claimed: false },
    t_two: { title: 'Learn to cook', updatedAt: 10, claimed: false },
  });
  const calls = serverThat({ ok: false, status: 401, json: async () => ({}) });

  const result = await claimLocalTrees();

  assert.deepEqual(plants(calls).map((call) => call.body), [{ id: 't_one', title: 'Learn to sail' }]);
  assert.deepEqual(result, { claimed: 0, pending: 2 });
  // The rows keep their claim state; the owner stamp is the first-contact attribution the identity
  // probe makes on any row written before entries named an account.
  assert.deepEqual(browser.index(), {
    t_one: { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: ME },
    t_two: { title: 'Learn to cook', updatedAt: 10, claimed: false, owner: ME },
  });
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-claim-done', detail: { claimed: 0, pending: 2 } },
  ]);
});

// The claim runs on every boot. An account with nothing to adopt must not flash the banner, and
// must not touch the wire at all.
test('a device with nothing unclaimed asks nothing and announces nothing', async () => {
  const browser = browserWith({ t_done: { title: 'Learn to sail', updatedAt: 20, claimed: true } });
  const calls = serverThat(planted('t_done'));

  const result = await claimLocalTrees();

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { claimed: 0 });
  assert.deepEqual(browser.events, []);
  assert.deepEqual(browser.index(), { t_done: { title: 'Learn to sail', updatedAt: 20, claimed: true, owner: ME } });
});

// The device-residue rule at the claim door (audit WEB-4): the anonymous work on this browser
// follows whoever signs in next — that is the anonymous-first door — but a row another account
// left unclaimed here is that account's, and signing in must not upload it into a stranger's.
test('an unclaimed row stamped for another account is not adopted — only the anonymous one is', async () => {
  const browser = browserWith({
    t_theirs: { title: 'A private therapy plan', updatedAt: 30, claimed: false, owner: 'u_other' },
    t_anon: { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: null },
  });
  const calls = serverThat(planted('t_anon'));

  const result = await claimLocalTrees({ openTreeId: 't_anon', openSession: () => openSessionFor('t_anon') });

  assert.deepEqual(plants(calls).map((call) => call.body), [{ id: 't_anon', title: 'Learn to sail' }]);
  assert.deepEqual(result, { claimed: 1, pending: 1 });
  assert.deepEqual(browser.index(), {
    t_theirs: { title: 'A private therapy plan', updatedAt: 30, claimed: false, owner: 'u_other' },
    t_anon: { title: 'Learn to sail', updatedAt: 20, claimed: true, owner: ME },
  });
  assert.deepEqual(browser.events, [
    { type: 'wm-claim-start', detail: null },
    { type: 'wm-tree-claimed', detail: { treeId: 't_anon' } },
    { type: 'wm-claim-done', detail: { claimed: 1, pending: 1 } },
  ]);
});

// A browser whose last account was killed rather than signed out still remembers them in the
// marker. A ghost holding it now has no account to claim into, and the server says so.
test('a ghost claims nothing — the marker is not an account, and no tree is planted', async () => {
  const browser = browserWith({ t_anon: { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: null } });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: false, status: 401, json: async () => ({}) };
  };

  const result = await claimLocalTrees();

  assert.deepEqual(calls, [`${BASE}/v1/me`]);
  assert.deepEqual(result, { claimed: 0 });
  assert.deepEqual(browser.events, []);
  assert.deepEqual(browser.index(), { t_anon: { title: 'Learn to sail', updatedAt: 20, claimed: false, owner: null } });
});
