import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine, ReplicaChanged } from '../../../src/platform/sync/engine.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { hashText } from '../../../src/platform/sync/core/encoding.js';
import { CarryOver, OldStores, dropUnclaimedPages, forgetClosedAccount, restoreUnclaimedPages, settleSeat, unclaimedPages } from '../../../src/products/journal/carry.js';
import { CarryLedger, Seat } from '../../../src/products/journal/domain/carry.js';
import { adoptDeviceRows, onSyncResult, pagesOf, pendingClaimWork, recoveredDrafts, savePage, SCOPE, watchClaims } from '../../../src/products/journal/pages.js';
import { environment, until } from '../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';

const day = '2026-09-27';
const doc = (body, date = day) => ({ day: date, body, mood: 0, energy: null, source: 'typed' });
function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { data, get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}
// One page as the journal's bundle before the engine kept it, under its day.
const entry = (body, { date = day, owed = true, read = true, stamp = '100:0:legacy' } = {}) =>
  ({ [date]: { page: { ...doc(body, date), stamp }, needsPush: owed, read } });
const stored = (...entries) => JSON.stringify(Object.assign({}, ...entries));

async function setup() {
  const env = environment();
  env.timers.time = Date.parse(`${day}T12:00:00Z`);
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: {}, B: {} } });
  env.options.registry = journalRegistry;
  env.options.pendingDeviceWork = pendingClaimWork;
  env.options.adoptDeviceRows = adoptDeviceRows;
  env.options.onPushResult = onSyncResult;
  env.transport.request = async (endpoint, request) => {
    const at = env.timers.time;
    let response;
    if (endpoint === 'hello') response = hello({ state, registry: journalRegistry, account: env.transport.account, serverTime: at });
    else {
      const result = (endpoint === 'push' ? push : pull)({ state, registry: journalRegistry, product: journalProduct,
        account: env.transport.account, request, serverNow: at });
      state = result.state; response = result.response;
    }
    return { response, timing: { send: { wall: at, mono: at, boot: 'test' }, recv: { wall: at, mono: at, boot: 'test' } } };
  };
  const engine = await BrowserSyncEngine.open(env.options);
  engine.observe(SCOPE);
  watchClaims(engine);
  await engine.start();
  await until(() => engine.leader);
  return { env, engine };
}

async function converge(engine) {
  for (let i = 0; i < 12; i++) { await engine.send(); await engine.pull(); }
  await until(() => engine.device.activeReplica.entries(SCOPE).length === 0);
}

// A carry over `data` whose events and reports the test reads, started: it answers once its first run ends.
async function carrying(engine, data, told = { events: [], reports: [] }, locks = null) {
  const carry = new CarryOver(engine, { stores: new OldStores(data), locks,
    track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) });
  await carry.start();
  return carry;
}

// What the shell runs before the seat changes (`sync.seatWillChange`), over `data`.
const seatWillChange = (engine, data, told = { events: [], reports: [] }) => settleSeat(engine, { stores: new OldStores(data),
  track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) });

// Every act the engine commits after the first `after` refused by the domain, as a part past its bound is.
function refusingAfter(engine, after) {
  const commitAct = engine.commitAct.bind(engine);
  let acts = 0;
  engine.commitAct = (prepare, segment, guard) => {
    acts += 1;
    if (acts <= after) return commitAct(prepare, segment, guard);
    return commitAct((context) => prepare({ ...context, stage: () => ({ refused: 'too-large', detail: null }) }), segment, guard);
  };
}

const claims = (engine) => engine.device.activeReplica.entries(SCOPE).flatMap((each) => (each.intent.cmd ? [each.intent.cmd.args] : []));
const bodies = (pages) => pages.map(({ day: date, body }) => ({ day: date, body }));

test('each seat\'s owed pages carry into its own replica as that replica becomes active, and an account\'s copies are left to its pull', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const data = storage({
    'wm.journal.v2.pages.u.A': stored(entry('owed A'), entry('cached A', { date: '2026-09-26', owed: false })),
    'wm.journal.v2.pages.u.B': stored(entry('owed B')),
    'wm.journal.pages.anon': JSON.stringify({ '2026-09-25': { page: { ...doc('anon', '2026-09-25'), mood: 2, energy: 3, stamp: '' }, needsPush: true, read: false } }),
  });
  try {
    const carry = await carrying(engine, data, told);
    assert.deepEqual([...data.data.keys()], ['wm.journal.v2.pages.u.A', 'wm.journal.v2.pages.u.B']);
    assert.deepEqual(pagesOf(engine).map(({ day: date, body, mood, energy }) => ({ date, body, mood, energy })), [{ date: '2026-09-25', body: 'anon', mood: 3, energy: 8 }]);
    assert.equal(engine.device.replicas.length, 1);

    env.transport.account = 'A'; await engine.signIn('A'); await carry.running;
    assert.deepEqual([...data.data.keys()], ['wm.journal.v2.pages.u.B']);
    assert.deepEqual(claims(engine).map(({ day: date, body }) => ({ day: date, body })), [{ day: '2026-09-25', body: 'anon' }, { day, body: 'owed A' }]);
    await converge(engine);
    assert.deepEqual(bodies(pagesOf(engine)), [{ day: '2026-09-25', body: 'anon' }, { day, body: 'owed A' }]);

    await engine.finishSignOut({ choice: 'keep' });
    env.transport.account = 'B'; await engine.signIn('B'); await carry.running;
    assert.equal(data.length, 0);
    assert.deepEqual(claims(engine).map(({ body }) => body), ['owed B']);
    assert.deepEqual(told, { reports: [], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'account', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'account', outcome: 'carried', pages: '1' }],
    ] });
  } finally { engine.close(); }
});

test('a store that will not delete keeps its carried pages; a restart deletes it and writes nothing twice', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('one copy', { read: false })) });
  data.removeItem = () => { throw new Error('storage denied'); };
  await carrying(engine, data, told);
  assert.equal(claims(engine).length, 1);
  assert.equal(data.length, 1);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  try {
    data.removeItem = (key) => data.data.delete(key);
    await carrying(reopened, data, told);
    assert.equal(claims(reopened).length, 1);
    assert.equal(data.length, 0);
    assert.deepEqual(told, { reports: [['journal-migration', 'clear']], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'anon', outcome: 'cleared', pages: '1' }],
    ] });
  } finally { reopened.close(); }
});

test('a store an old tab changed after a blocked deletion carries its new page, keeps a changed page of a carried day to recover, and converges', async () => {
  const { engine, env } = await setup();
  const key = 'wm.journal.v2.pages.anon';
  const nextDay = '2026-09-28';
  const data = storage({ [key]: stored(entry('original words', { read: false })) });
  data.removeItem = () => { throw new Error('blocked source cleanup'); };
  try {
    await carrying(engine, data);
    data.setItem(key, stored(entry('corrected words', { read: false, stamp: '101:0:legacy' }), entry('new contribution', { date: nextDay, read: false })));
    data.removeItem = (removed) => data.data.delete(removed);
    await carrying(engine, data);
    assert.equal(data.length, 0);
    assert.deepEqual(claims(engine).map(({ body }) => body), ['original words', 'new contribution']);
    assert.deepEqual(bodies(recoveredDrafts(engine)), [{ day, body: 'corrected words' }]);
    env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
    assert.deepEqual(bodies(pagesOf(engine)), [{ day, body: 'original words' }, { day: nextDay, body: 'new contribution' }]);
    assert.deepEqual(bodies(recoveredDrafts(engine)), [{ day, body: 'corrected words' }]);
  } finally { engine.close(); }
});

test('an entry that does not read stays in its store, told once, beside the pages that carry; a write that fails leaves every store whole', async () => {
  const { engine } = await setup();
  const told = { events: [], reports: [] };
  const key = 'wm.journal.v2.pages.anon';
  const unread = { invalid: entry('bad day')[day] };
  const data = storage({ [key]: stored(entry('keep this'), unread) });
  try {
    const carry = await carrying(engine, data, told);
    assert.deepEqual([...data.data.entries()], [[key, JSON.stringify(unread)]]);
    assert.deepEqual(bodies(pagesOf(engine)), [{ day, body: 'keep this' }]);
    await carry.run();
    assert.deepEqual(told.reports, [['journal-migration', 'read']]);

    data.setItem(key, stored(entry('new writing', { date: '2026-09-28' }), unread));
    const transact = engine.store.transact;
    engine.store.transact = async () => { throw new Error('quota'); };
    await carrying(engine, data, told);
    engine.store.transact = transact;
    assert.deepEqual(claims(engine).map(({ body }) => body), ['keep this']);
    assert.equal(data.data.get(key), stored(entry('new writing', { date: '2026-09-28' }), unread));
    assert.deepEqual(told, { reports: [['journal-migration', 'read'], ['journal-migration', 'read'], ['journal-migration', 'write']], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'anon', outcome: 'failed', pages: '1' }],
    ] });
  } finally { engine.close(); }
});

test('a browser that refuses its storage opens the journal all the same', async () => {
  const { engine } = await setup();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('blocked test storage', 'SecurityError'); } });
  const reports = [];
  try {
    await new CarryOver(engine, { locks: null, track: () => {}, report: (operation, stage) => reports.push([operation, stage]) }).start();
    assert.deepEqual(reports, [['journal-migration', 'read']]);
    assert.deepEqual(unclaimedPages(), []);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    engine.close();
  }
});

test('a page another store holds of the same day with other words is kept to recover, once', async () => {
  const { engine } = await setup();
  const data = storage({
    'wm.journal.pages.anon': stored(entry('earlier source writing', { read: false, stamp: '90:0:legacy' })),
    'wm.journal.v2.pages.anon': stored(entry('newer source writing', { read: false, stamp: '100:0:legacy' })),
  });
  try {
    await carrying(engine, data);
    assert.equal(data.length, 0);
    assert.deepEqual(bodies(pagesOf(engine)), [{ day, body: 'newer source writing' }]);
    assert.deepEqual(bodies(recoveredDrafts(engine)), [{ day, body: 'earlier source writing' }]);
    assert.equal(engine.device.activeReplica.entries(SCOPE).filter((each) => each.intent.cmd).length, 1);
    data.setItem('wm.journal.pages.anon', stored(entry('earlier source writing', { read: false, stamp: '90:0:legacy' })));
    await carrying(engine, data);
    assert.equal(recoveredDrafts(engine).length, 1);
  } finally { engine.close(); }
});

test('an owed page the browser never read wins over a newer copy the account sent, across the two versions\' stores', async () => {
  const { engine, env } = await setup();
  const data = storage({
    'wm.journal.pages.u.A': stored(entry('cached older prose', { owed: false, stamp: '1000:0:legacy' })),
    'wm.journal.v2.pages.u.A': stored(entry('unsent contribution', { read: false, stamp: '' })),
  });
  try {
    const carry = await carrying(engine, data);
    assert.equal(data.length, 2);
    env.transport.account = 'A'; await engine.signIn('A'); await carry.running;
    assert.deepEqual(claims(engine).map(({ body }) => body), ['unsent contribution']);
    assert.deepEqual(recoveredDrafts(engine), []);
    assert.equal(data.length, 0);
  } finally { engine.close(); }
});

test('oversized writing stays editable while the pages beside it carry, and the first open completes', async () => {
  const { env, engine } = await setup();
  engine.close();
  const body = 'legacy writing '.repeat(10_000);
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry(body, { read: false }), entry('valid older page', { date: '2026-09-26', read: false })) });
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  const session = new syncSession.constructor();
  try {
    await session.open({ ...env.options, prepare: (opened) => new CarryOver(opened, { stores: new OldStores(data), locks: null, track: () => {} }).start() });
    assert.deepEqual({ ready: session.snapshot.ready, error: session.snapshot.error, closed: session.engine.closed }, { ready: true, error: false, closed: false });
    assert.equal(data.length, 0);
    assert.deepEqual(bodies(pagesOf(session.engine)), [{ day: '2026-09-26', body: 'valid older page' }, { day, body }]);
    assert.deepEqual(claims(session.engine).map((args) => args.body), ['valid older page']);
    await savePage(session.engine, doc('corrected legacy writing'));
    assert.equal(pagesOf(session.engine).find((page) => page.day === day).body, 'corrected legacy writing');
    assert.deepEqual(bodies(recoveredDrafts(session.engine)), [{ day, body }]);
  } finally {
    session.engine?.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('a run a sign-in overtakes writes nothing and leaves every store whole; each replica then takes only its own seat', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('signed out', { read: false })) });
  const told = { events: [], reports: [] };
  const commitAct = engine.commitAct.bind(engine);
  let overtaken = false;
  engine.commitAct = async (...args) => {
    if (!overtaken) {
      overtaken = true;
      env.transport.account = 'A';
      await engine.signIn('A');
    }
    return commitAct(...args);
  };
  try {
    const carry = await carrying(engine, data, told);
    await carry.running;
    assert.equal(engine.device.activeReplica.meta.account, 'A');
    assert.deepEqual(claims(engine), []);
    assert.equal(data.length, 1);
    await engine.finishSignOut({ choice: 'keep' });
    await carry.running;
    assert.equal(engine.device.activeReplica.meta.state, 'anon');
    assert.deepEqual(claims(engine).map(({ body }) => body), ['signed out']);
    assert.equal(data.length, 0);
    assert.deepEqual(told, { reports: [], events: [['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }]] });
  } finally { engine.close(); }
});

test('before the seat changes the pages its replica\'s ledger records leave their stores, so a Discard takes those it counted and keeps the rest for the account\'s next sign-in', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const key = 'wm.journal.v2.pages.u.A';
  const unread = { '2026-09-10': { page: { ...doc('a stamp that does not read', '2026-09-10'), stamp: 'later' }, needsPush: true, read: true } };
  const carried = entry('carried', { date: '2026-09-20' });
  const since = entry('written since in an old tab', { date: '2026-09-21' });
  const data = storage({ [key]: stored(carried, unread) });
  const { setItem, removeItem } = data;
  data.setItem = () => { throw new Error('storage denied'); };
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    const carry = await carrying(engine, data, told);
    data.setItem = setItem;
    data.setItem(key, stored(carried, since, unread));
    data.removeItem = removeItem;
    seatWillChange(engine, data, told);
    assert.equal(data.data.get(key), stored(since, unread));
    await engine.finishSignOut({ choice: 'discard' }); await carry.running;
    assert.equal(data.data.get(key), stored(since, unread));
    await engine.signIn('A'); await carry.running;
    assert.deepEqual(claims(engine).map(({ body }) => body), ['written since in an old tab']);
    assert.equal(data.data.get(key), JSON.stringify(unread));
    assert.deepEqual(told, { reports: [['journal-migration', 'read'], ['journal-migration', 'clear']], events: [
      ['journal_carry', { seat: 'account', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'account', outcome: 'cleared', pages: '1' }],
      ['journal_carry', { seat: 'account', outcome: 'carried', pages: '1' }],
    ] });
  } finally { engine.close(); }
});

test('an account\'s closure deletes every page this browser kept of its seat, carried or not and read or not, and no other seat\'s', () => {
  const told = { events: [], reports: [] };
  const unread = { '2026-09-10': { page: { ...doc('a stamp that does not read', '2026-09-10'), stamp: 'later' }, needsPush: true, read: true } };
  const others = {
    'wm.journal.v2.pages.u.B': stored(entry('B\'s page')),
    'wm.journal.v2.pages.anon': stored(entry('written signed out')),
    'wm.journal.v2.pages.unclaimed': stored(entry('nobody\'s to say')),
  };
  const data = storage({ ...others, 'wm.journal.v2.pages.u.A': stored(entry('owed to A'), unread),
    'wm.journal.pages.u.A': stored(entry('owed to A in the first version', { date: '2026-09-26' })) });
  const options = { stores: new OldStores(data), track: (name, props) => told.events.push([name, props]),
    report: (operation, stage) => told.reports.push([operation, stage]) };
  forgetClosedAccount('A', options);
  forgetClosedAccount('A', { ...options, stores: new OldStores({ get length() { throw new Error('storage denied'); } }) });
  assert.deepEqual({ left: Object.fromEntries(data.data), told }, { left: others, told: {
    events: [['journal_carry', { seat: 'account', outcome: 'cleared', pages: '2-5' }]], reports: [['journal-migration', 'clear']] } });
});

test('a carry that fails leaves an account\'s owed pages, which its sign-out\'s Discard never counted, for its next sign-in', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const key = 'wm.journal.v2.pages.u.A';
  const owed = stored(entry('owed one', { date: '2026-09-20' }), entry('owed two', { date: '2026-09-21' }));
  const data = storage({ [key]: owed });
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    const transact = engine.store.transact;
    engine.store.transact = async (change, options = {}) => {
      if (!options.readonly) throw new Error('quota');
      return transact.call(engine.store, change, options);
    };
    const carry = await carrying(engine, data, told);
    engine.store.transact = transact;
    seatWillChange(engine, data, told);
    await engine.finishSignOut({ choice: 'discard' }); await carry.running;
    assert.equal(data.data.get(key), owed);
    await engine.signIn('A'); await carry.running;
    assert.deepEqual(claims(engine).map(({ body }) => body), ['owed one', 'owed two']);
    assert.equal(data.length, 0);
    assert.deepEqual(told, { reports: [['journal-migration', 'write']], events: [
      ['journal_carry', { seat: 'account', outcome: 'failed', pages: '2-5' }],
      ['journal_carry', { seat: 'account', outcome: 'carried', pages: '2-5' }],
    ] });
  } finally { engine.close(); }
});

test('a sign-in between two acts leaves the signed-out stores only what is still owed, so no page reaches two replicas', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const key = 'wm.journal.v2.pages.anon';
  const pages = Array.from({ length: 30 }, (_, index) => entry(`signed out ${index}`, { date: `2026-07-${String(index + 1).padStart(2, '0')}`, read: false }));
  const data = storage({ [key]: stored(...pages) });
  const commitAct = engine.commitAct.bind(engine);
  let acts = 0;
  engine.commitAct = async (...args) => {
    acts += 1;
    if (acts === 2) { env.transport.account = 'A'; await engine.signIn('A'); }
    return commitAct(...args);
  };
  try {
    const carry = await carrying(engine, data, told);
    await carry.running;
    engine.commitAct = commitAct;
    assert.deepEqual(claims(engine).map(({ body }) => body), Array.from({ length: 20 }, (_, index) => `signed out ${index}`));
    assert.equal(data.data.get(key), stored(...pages.slice(20)));
    await engine.finishSignOut({ choice: 'keep' }); await carry.running;
    assert.equal(data.length, 0);
    env.transport.account = 'B'; await engine.signIn('B'); await carry.running;
    assert.deepEqual(claims(engine).map(({ body }) => body), Array.from({ length: 10 }, (_, index) => `signed out ${index + 20}`));
    assert.deepEqual(told, { reports: [], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '6-20' }],
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '6-20' }],
    ] });
  } finally { engine.close(); }
});

test('a signed-out page whose store would not change leaves it before a sign-in, so the sign-in\'s Discard does not bring it back', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('signed out words', { read: false })) });
  const { removeItem } = data;
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    await savePage(engine, doc('the account\'s page')); await converge(engine);
    await engine.finishSignOut({ choice: 'keep' });
    data.removeItem = () => { throw new Error('storage denied'); };
    const carry = await carrying(engine, data, told);
    data.removeItem = removeItem;
    assert.equal(data.length, 1);
    seatWillChange(engine, data, told);
    assert.equal(data.length, 0);
    assert.equal((await engine.signIn('A', { decisions: { journal: 'discard' } })).complete, true);
    await carry.running;
    await engine.finishSignOut({ choice: 'keep' }); await carry.running;
    assert.equal(engine.device.activeReplica.meta.state, 'anon');
    assert.deepEqual(claims(engine), []);
    assert.deepEqual(told, { reports: [['journal-migration', 'clear']], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }],
      ['journal_carry', { seat: 'anon', outcome: 'cleared', pages: '1' }],
    ] });
  } finally { engine.close(); }
});

test('words no digest can name stay in their store unread while the pages beside them carry, and the unattributed pages beside them are listed', async () => {
  const { engine } = await setup();
  const told = { events: [], reports: [] };
  const lone = entry('a lone \ud800 surrogate', { date: '2026-09-21', read: false });
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('fine', { date: '2026-09-20', read: false }), lone),
    'wm.journal.v2.pages.unclaimed': stored(entry('unattributed', { date: '2026-09-20' }), lone) });
  try {
    await carrying(engine, data, told);
    assert.deepEqual(claims(engine).map(({ body }) => body), ['fine']);
    assert.equal(data.data.get('wm.journal.v2.pages.anon'), stored(lone));
    assert.deepEqual(unclaimedPages(new OldStores(data)).map(({ day: date, body }) => ({ day: date, body })), [{ day: '2026-09-20', body: 'unattributed' }]);
    assert.deepEqual(told, { reports: [['journal-migration', 'read']], events: [['journal_carry', { seat: 'anon', outcome: 'carried', pages: '1' }]] });
  } finally { engine.close(); }
});

test('an act the domain refuses ends the run, told and not reported, its pages and those after it left owed in their store', async () => {
  const { engine } = await setup();
  const told = { events: [], reports: [] };
  const key = 'wm.journal.v2.pages.anon';
  const pages = Array.from({ length: 25 }, (_, index) => entry(`page ${index}`, { date: `2026-07-${String(index + 1).padStart(2, '0')}`, read: false }));
  const data = storage({ [key]: stored(...pages) });
  refusingAfter(engine, 1);
  try {
    await carrying(engine, data, told);
    assert.equal(claims(engine).length, 20);
    assert.equal(data.data.get(key), stored(...pages.slice(20)));
    assert.deepEqual(told, { reports: [], events: [
      ['journal_carry', { seat: 'anon', outcome: 'carried', pages: '6-20' }],
      ['journal_carry', { seat: 'anon', outcome: 'refused', pages: '2-5' }],
    ] });
  } finally { engine.close(); }
});

test('no carry writes into a replica while its sign-out question stands; it runs once the question is cancelled', async () => {
  const { engine, env } = await setup();
  const told = { events: [], reports: [] };
  const data = storage({ 'wm.journal.v2.pages.u.A': stored(entry('owed A')) });
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    engine.setOnline(false);
    await engine.beginSignOut();
    const carry = await carrying(engine, data, told);
    assert.deepEqual(claims(engine), []);
    assert.equal(data.length, 1);
    await engine.cancelSignOut(); await carry.running;
    assert.deepEqual(claims(engine).map(({ body }) => body), ['owed A']);
    assert.equal(data.length, 0);
    assert.deepEqual(told, { reports: [], events: [['journal_carry', { seat: 'account', outcome: 'carried', pages: '1' }]] });
  } finally { engine.close(); }
});

test('a tab that finds another carrying opens without waiting for it, and the page is carried once', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('one', { read: false })) });
  const held = new Map();
  const locks = {
    async request(name, { ifAvailable = false }, callback) {
      if (held.has(name) && ifAvailable) return callback(null);
      while (held.has(name)) await held.get(name);
      let release;
      held.set(name, new Promise((resolve) => { release = resolve; }));
      try { return await callback({ name }); } finally { held.delete(name); release(); }
    },
  };
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const commitAct = engine.commitAct.bind(engine);
  engine.commitAct = async (...args) => { await gate; return commitAct(...args); };
  const second = await BrowserSyncEngine.open(env.options);
  await second.start();
  try {
    const first = carrying(engine, data, undefined, locks);
    let opened = false;
    carrying(second, data, undefined, locks).then(() => { opened = true; });
    await until(() => opened);
    open(); await first;
    await second.refresh();
    assert.deepEqual(claims(second).map(({ body }) => body), ['one']);
    assert.equal(data.length, 0);
  } finally { second.close(); engine.close(); }
});

test('a device held in memory carries nothing, so the stores outlive no copy of theirs', async () => {
  const env = environment();
  env.options.registry = journalRegistry;
  const engine = await BrowserSyncEngine.open({ ...env.options, inMemory: true });
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('kept on disk')) });
  try {
    await carrying(engine, data);
    assert.deepEqual(claims(engine), []);
    assert.equal(data.length, 1);
  } finally { engine.close(); }
});

test('what the journal\'s first bundle on the engine left in the device\'s metadata returns to storage, once, and leaves the metadata', async () => {
  const { engine } = await setup();
  const told = { events: [], reports: [] };
  const carriedWhole = stored(entry('carried whole', { read: false }));
  const page = (body, extra = {}) => ({ day, body, mood: null, energy: null, source: 'typed', stamp: '100:0:legacy', ...extra });
  const receipt = hashText(JSON.stringify(['B', page('carried by the first bundle')]));
  const data = storage({
    'wm.journal.v2.pages.anon': carriedWhole,
    'wm.journal.v2.pages.u.B': JSON.stringify({ [day]: { page: page('carried by the first bundle'), needsPush: true, read: false },
      ...entry('not carried yet', { date: '2026-09-28', read: false }) }),
  });
  await engine.write(null, (device) => {
    device.meta.journalUnclaimed = [page('kept for whoever restores'), page('lost its day', { recovered: true })];
    device.meta.journalMigration = { 'wm.journal.v2.pages.anon': hashText(carriedWhole) };
    device.meta.journalMigrationEntries = { [receipt]: 'claim-1' };
  });
  try {
    const stores = new OldStores(data);
    await carrying(engine, data, told);
    assert.deepEqual(Object.keys(engine.device.meta).filter((key) => key.startsWith('journal')), []);
    assert.deepEqual(claims(engine), []);
    assert.deepEqual(JSON.parse(data.data.get('wm.journal.v2.pages.u.B')), entry('not carried yet', { date: '2026-09-28', read: false }));
    assert.equal(data.data.has('wm.journal.v2.pages.anon'), false);
    assert.deepEqual(unclaimedPages(stores).map(({ day: date, body }) => ({ day: date, body })),
      [{ day, body: 'kept for whoever restores' }, { day, body: 'lost its day' }]);
    assert.deepEqual(told, { reports: [], events: [['journal_carry', { seat: 'unclaimed', outcome: 'returned', pages: '2-5' }]] });

    await carrying(engine, data, told);
    assert.equal(unclaimedPages(stores).length, 2);
    assert.equal(told.events.length, 1);
  } finally { engine.close(); }
});

test('a page another tab puts in the metadata while its pages return is returned at the next run, and the pages returned before stay', async () => {
  const { engine } = await setup();
  const told = { events: [], reports: [] };
  const page = (body, date) => ({ day: date, body, mood: null, energy: null, source: 'typed', stamp: '100:0:legacy' });
  const returned = page('returned first', '2026-09-20');
  const data = storage();
  await engine.write(null, (device) => {
    device.meta.journalUnclaimed = [returned];
    device.meta.journalMigrationEntries = { [hashText(JSON.stringify(['anon', returned]))]: 'claim-1' };
  });
  const write = engine.write.bind(engine);
  engine.write = async (...args) => {
    engine.write = write;
    await write(null, (device) => { device.meta.journalUnclaimed = [page('put there meanwhile', '2026-09-21')]; });
    return write(...args);
  };
  try {
    await carrying(engine, data, told);
    assert.deepEqual(unclaimedPages(new OldStores(data)).map(({ body }) => body), ['returned first']);
    assert.deepEqual(Object.keys(engine.device.meta).filter((key) => key.startsWith('journal')).sort(), ['journalMigrationEntries', 'journalUnclaimed']);
    await carrying(engine, data, told);
    assert.deepEqual(unclaimedPages(new OldStores(data)).map(({ body }) => body), ['returned first', 'put there meanwhile']);
    assert.deepEqual(Object.keys(engine.device.meta).filter((key) => key.startsWith('journal')), []);
    assert.deepEqual(told, { reports: [], events: [['journal_carry', { seat: 'unclaimed', outcome: 'returned', pages: '1' }]] });
  } finally { engine.close(); }
});

test('unattributed pages wait in storage through sign-in, restore as claims that converge, and go from storage', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.pages': stored(entry('unowned')) });
  const stores = new OldStores(data);
  const events = [];
  const track = (name, props) => events.push([name, props]);
  try {
    await carrying(engine, data);
    assert.equal(unclaimedPages(stores).length, 1);
    assert.deepEqual(pagesOf(engine), []);
    env.transport.account = 'A'; await engine.signIn('A');
    assert.equal(unclaimedPages(stores).length, 1);
    assert.equal(await restoreUnclaimedPages('A', { engine, stores, track }), 1);
    assert.equal(data.length, 0);
    assert.equal(await restoreUnclaimedPages('A', { engine, stores, track }), 0);
    await converge(engine);
    assert.deepEqual(bodies(pagesOf(engine)), [{ day, body: 'unowned' }]);
    assert.deepEqual(events, [
      ['journal_unclaimed', { action: 'restore', outcome: 'ok', pages: '1' }],
      ['journal_unclaimed', { action: 'restore', outcome: 'none', pages: '0' }],
    ]);
  } finally { engine.close(); }
});

test('an oversized unattributed page restores for correction, once, without blocking writing', async () => {
  const { engine, env } = await setup();
  const body = 'quarantined writing '.repeat(8_000);
  const stores = new OldStores(storage({ 'wm.journal.pages.unclaimed': stored(entry(body)) }));
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    assert.equal(await restoreUnclaimedPages('A', { engine, stores, track: () => {} }), 1);
    assert.deepEqual(unclaimedPages(stores), []);
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, body);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
    assert.equal(await restoreUnclaimedPages('A', { engine, stores, track: () => {} }), 0);
    await savePage(engine, doc('corrected quarantined writing'));
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, 'corrected quarantined writing');
  } finally { engine.close(); }
});

test('a restore asks for the account the replica is bound to, told and not reported, and a discard deletes the pages it listed without writing to the engine', async () => {
  const { engine, env } = await setup();
  const unread = { invalid: entry('no day')[day] };
  const data = storage({ 'wm.journal.v2.pages.unclaimed': stored(entry('unowned'), unread) });
  const stores = new OldStores(data);
  const told = { events: [], reports: [] };
  const options = { engine, stores, track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) };
  try {
    await assert.rejects(restoreUnclaimedPages('A', options), ReplicaChanged);
    env.transport.account = 'A'; await engine.signIn('A');
    await assert.rejects(restoreUnclaimedPages('B', options), ReplicaChanged);
    const revision = engine.revision;
    const listed = unclaimedPages(stores).map((page) => page.key);
    assert.equal(dropUnclaimedPages(listed, options), 1);
    assert.equal(engine.revision, revision);
    assert.deepEqual([...data.data.entries()], [['wm.journal.v2.pages.unclaimed', JSON.stringify(unread)]]);
    assert.equal(dropUnclaimedPages(listed, options), 0);
    assert.deepEqual(told, { reports: [], events: [
      ['journal_unclaimed', { action: 'restore', outcome: 'replica_changed', pages: '0' }],
      ['journal_unclaimed', { action: 'restore', outcome: 'replica_changed', pages: '0' }],
      ['journal_unclaimed', { action: 'discard', outcome: 'ok', pages: '1' }],
      ['journal_unclaimed', { action: 'discard', outcome: 'none', pages: '0' }],
    ] });
  } finally { engine.close(); }
});

test('a restore the account changes under writes nothing into the next account\'s replica, and one the domain refuses writes nothing; the pages wait', async () => {
  const { engine, env } = await setup();
  const key = 'wm.journal.v2.pages.unclaimed';
  const data = storage({ [key]: stored(entry('unowned')) });
  const told = { events: [], reports: [] };
  const options = { engine, stores: new OldStores(data), track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) };
  const commitAct = engine.commitAct.bind(engine);
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    engine.commitAct = async (...args) => {
      engine.commitAct = commitAct;
      await engine.finishSignOut({ choice: 'keep' });
      env.transport.account = 'B'; await engine.signIn('B');
      return commitAct(...args);
    };
    await assert.rejects(restoreUnclaimedPages('A', options), ReplicaChanged);
    assert.equal(engine.device.activeReplica.meta.account, 'B');
    assert.deepEqual(claims(engine), []);
    refusingAfter(engine, 0);
    await assert.rejects(restoreUnclaimedPages('B', options));
    assert.deepEqual(claims(engine), []);
    assert.equal(data.data.get(key), stored(entry('unowned')));
    assert.deepEqual(told, { reports: [], events: [
      ['journal_unclaimed', { action: 'restore', outcome: 'replica_changed', pages: '0' }],
      ['journal_unclaimed', { action: 'restore', outcome: 'refused', pages: '0' }],
    ] });
  } finally { engine.close(); }
});

test('Settings\' Discard deletes the pages it listed and none that arrived since', async () => {
  const data = storage({ 'wm.journal.v2.pages.unclaimed': stored(entry('listed', { date: '2026-09-20' })) });
  const stores = new OldStores(data);
  const events = [];
  const listed = unclaimedPages(stores).map((page) => page.key);
  data.setItem('wm.journal.v2.pages.unclaimed', stored(entry('listed', { date: '2026-09-20' }), entry('arrived since', { date: '2026-09-21' })));
  data.setItem('wm.journal.v2.pages.unclaimed.0123456789abcdef', stored(entry('returned since', { date: '2026-09-22' })));
  assert.equal(dropUnclaimedPages(listed, { stores, track: (name, props) => events.push([name, props]) }), 1);
  assert.deepEqual(unclaimedPages(stores).map(({ body }) => body), ['arrived since', 'returned since']);
  assert.deepEqual(events, [['journal_unclaimed', { action: 'discard', outcome: 'ok', pages: '1' }]]);
});

test('the first version\'s cached copies of an account\'s pages are neither listed nor restored, and go with their store', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.pages': stored(entry('unsent before scoping', { date: '2026-09-20' }), entry('a cached copy', { date: '2026-09-21', owed: false })) });
  const stores = new OldStores(data);
  try {
    assert.deepEqual(unclaimedPages(stores).map(({ body }) => body), ['unsent before scoping']);
    env.transport.account = 'A'; await engine.signIn('A');
    assert.equal(await restoreUnclaimedPages('A', { engine, stores, track: () => {} }), 1);
    assert.deepEqual(claims(engine).map(({ body }) => body), ['unsent before scoping']);
    assert.equal(data.length, 0);
  } finally { engine.close(); }
});

test('the ledger lives in the replica the pages went to, a device row the registry declares', async () => {
  const { engine } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': stored(entry('one')) });
  try {
    await carrying(engine, data);
    const rows = engine.readDeviceRows('journal');
    const [digest] = rows[CarryLedger.key(Seat.anon)].pages;
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(rows).filter((key) => !key.startsWith('pendingClaim:')), [CarryLedger.key(Seat.anon)]);
    assert.deepEqual(Object.keys(engine.device.meta).filter((key) => key.startsWith('journal')), []);
  } finally { engine.close(); }
});
