import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { hashText } from '../../../src/platform/sync/core/encoding.js';
import { CarryOver, OldStores, dropUnclaimedPages, forgetSeat, restoreUnclaimedPages, unclaimedPages } from '../../../src/products/journal/carry.js';
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
async function carrying(engine, data, told = { events: [], reports: [] }) {
  const carry = new CarryOver(engine, { stores: new OldStores(data), locks: null,
    track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) });
  await carry.start();
  return carry;
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

test('a Discard that takes an account\'s replica takes its stores; a Keep leaves them for its next sign-in', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.v2.pages.u.A': stored(entry('owed A')), 'wm.journal.v2.pages.u.B': stored(entry('owed B')) });
  const events = [];
  const forget = () => forgetSeat({ previous: 'A', next: null }, { engine, stores: new OldStores(data), track: (name, props) => events.push([name, props]) });
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    await engine.finishSignOut({ choice: 'keep' });
    forget();
    assert.equal(data.length, 2);
    await engine.signIn('A');
    await engine.finishSignOut({ choice: 'discard' });
    forget();
    assert.deepEqual([...data.data.keys()], ['wm.journal.v2.pages.u.B']);
    assert.deepEqual(events, [['journal_carry', { seat: 'account', outcome: 'discarded', pages: '1' }]]);
  } finally { engine.close(); }
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

test('a restore asks for the account the replica is bound to, and a discard deletes the pages without writing to the engine', async () => {
  const { engine, env } = await setup();
  const unread = { invalid: entry('no day')[day] };
  const data = storage({ 'wm.journal.v2.pages.unclaimed': stored(entry('unowned'), unread) });
  const stores = new OldStores(data);
  const told = { events: [], reports: [] };
  const options = { engine, stores, track: (name, props) => told.events.push([name, props]), report: (operation, stage) => told.reports.push([operation, stage]) };
  try {
    await assert.rejects(restoreUnclaimedPages('A', options), /account changed/);
    env.transport.account = 'A'; await engine.signIn('A');
    await assert.rejects(restoreUnclaimedPages('B', options), /account changed/);
    const revision = engine.revision;
    assert.equal(dropUnclaimedPages(options), 1);
    assert.equal(engine.revision, revision);
    assert.deepEqual([...data.data.entries()], [['wm.journal.v2.pages.unclaimed', JSON.stringify(unread)]]);
    assert.equal(dropUnclaimedPages(options), 0);
    assert.deepEqual(told, { reports: [['journal-restore', 'restore'], ['journal-restore', 'restore']], events: [
      ['journal_unclaimed', { action: 'restore', outcome: 'failed', pages: '0' }],
      ['journal_unclaimed', { action: 'restore', outcome: 'failed', pages: '0' }],
      ['journal_unclaimed', { action: 'discard', outcome: 'ok', pages: '1' }],
      ['journal_unclaimed', { action: 'discard', outcome: 'none', pages: '0' }],
    ] });
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
