import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { pendingClaimWork } from '../../../src/products/journal/claims.js';
import { migratePages } from '../../../src/products/journal/migrate.js';
import { pagesOf, savePage, watchClaims, onSyncResult, SCOPE, restoreUnclaimedPages, unclaimedPages } from '../../../src/products/journal/pages.js';
import { environment, until } from '../../platform/sync/fakes.js';
import { journalRegistry, journalProduct } from '../../platform/sync/oracle-adapters/journal.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';

const day = '2026-09-27';
const doc = (body, date = day) => ({ day: date, body, mood: 0, energy: null, source: 'typed' });
function storage(values = {}) {
  const data = new Map(Object.entries(values));
  return { data, get length() { return data.size; }, key: (index) => [...data.keys()][index],
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}
const entry = (body, needsPush = true, read = true, stamp = '100:0:legacy') => ({ page: { ...doc(body), stamp }, needsPush, read });
async function setup() {
  const env = environment();
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: {}, B: {} } });
  env.options.registry = journalRegistry;
  env.options.pendingDeviceWork = pendingClaimWork;
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

test('anonymous autosaves supersede per day; offline restart retains the full latest document', async () => {
  const { engine, env } = await setup();
  await savePage(engine, doc('first'));
  await savePage(engine, doc('latest'));
  assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  assert.equal(Object.keys(engine.device.activeReplica.deviceRows('journal')).filter((key) => key.startsWith('pendingClaim:')).length, 1);
  assert.equal(pagesOf(engine)[0].body, 'latest');
  engine.close();
  env.options.navigator.onLine = false;
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(pagesOf(reopened)[0].body, 'latest');
  reopened.close();
});

test('an edit behind a delayed claim survives restart and reconciles after result and covering pull', async () => {
  const { engine, env } = await setup();
  await savePage(engine, doc('frozen'));
  env.transport.account = 'A'; await engine.signIn('A');
  await savePage(engine, doc('newer typing'));
  assert.equal(engine.device.activeReplica.entries(SCOPE)[0].intent.cmd.name, 'journal.claimPage');
  assert.equal(engine.device.activeReplica.entries(SCOPE)[0].intent.cmd.args.body, 'frozen');
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options); watchClaims(reopened);
  await reopened.start(); await until(() => reopened.leader);
  assert.equal(pagesOf(reopened)[0].body, 'newer typing');
  env.timers.time += 100;
  await converge(reopened);
  assert.equal(pagesOf(reopened)[0].body, 'newer typing');
  assert.equal(Object.keys(reopened.device.activeReplica.deviceRows('journal')).filter((key) => key.startsWith('pendingClaim:')).length, 0);
  assert.ok(reopened.device.activeReplica.confirmedRow(SCOPE, 'page', day).f.documentStamp[0].ms >= 1100);
  reopened.close();
});

test('migration imports caches and owed commands per account, anonymous work and v1 scales', async () => {
  const { engine } = await setup();
  const data = storage({
    'wm.journal.v2.pages.u.A': JSON.stringify({ [day]: entry('owed A'), '2026-09-26': { ...entry('cached A', false), page: { ...doc('cached A', '2026-09-26'), stamp: '99:0:legacy' } } }),
    'wm.journal.v2.pages.u.B': JSON.stringify({ [day]: entry('owed B') }),
    'wm.journal.pages.anon': JSON.stringify({ [day]: { page: { ...doc('anon'), mood: 2, energy: 3, stamp: '' }, needsPush: true, read: false } }),
  });
  await migratePages(engine, data);
  assert.equal(data.length, 0);
  assert.equal(engine.device.dormantOf('A').entries(SCOPE)[0].intent.cmd.args.body, 'owed A');
  assert.equal(engine.device.dormantOf('B').entries(SCOPE)[0].lineage, 'B');
  const persisted = await engine.store.read();
  assert.equal(persisted.device.dormantOf('A').confirmedRows(SCOPE).filter((row) => row.t === 'page').length, 2);
  assert.equal(persisted.device.dormantOf('A').confirmedRow(SCOPE, 'journalState', 'journalState').f.scales[0], 'retired');
  assert.equal(engine.observe(SCOPE).getSnapshot().drawn.find((row) => row.t === 'journalState').f.scales[0], 'retired');
  assert.deepEqual(pagesOf(engine).map(({ body, mood, energy }) => ({ body, mood, energy })), [{ body: 'anon', mood: 3, energy: 8 }]);
  engine.close();
});

test('a crash or blocked deletion after migration cannot enqueue or append the same page twice', async () => {
  const { engine, env } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': JSON.stringify({ [day]: entry('one copy', true, false) }) });
  data.removeItem = () => { throw new Error('storage denied'); };
  await assert.rejects(migratePages(engine, data));
  assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  data.removeItem = (key) => data.data.delete(key);
  await migratePages(reopened, data);
  assert.equal(reopened.device.activeReplica.entries(SCOPE).length, 1);
  assert.equal(data.length, 0);
  reopened.close();
});

test('a changed legacy key imports only new entries after blocked cleanup and restart', async () => {
  const { engine, env } = await setup();
  const key = 'wm.journal.v2.pages.anon';
  const data = storage({ [key]: JSON.stringify({ [day]: entry('one copy', true, false) }) });
  data.removeItem = () => { throw new Error('storage denied'); };
  await assert.rejects(migratePages(engine, data));
  const original = engine.device.activeReplica.entries(SCOPE)[0].intent.cmd.args.claimId;
  const receipts = (await engine.store.read()).device.meta.journalMigrationEntries;
  assert.deepEqual(Object.values(receipts), [original]);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  const nextDay = '2026-09-28';
  data.setItem(key, JSON.stringify({ [day]: entry('one copy', true, false),
    [nextDay]: { ...entry('new contribution', true, false), page: { ...doc('new contribution', nextDay), stamp: '100:0:legacy' } } }));
  data.removeItem = (key) => data.data.delete(key);
  await migratePages(reopened, data);
  const claims = reopened.device.activeReplica.entries(SCOPE).map((row) => row.intent.cmd.args);
  assert.deepEqual(claims.map(({ day, body }) => ({ day, body })), [
    { day, body: 'one copy' }, { day: nextDay, body: 'new contribution' },
  ]);
  assert.equal(claims[0].claimId, original);
  assert.deepEqual(Object.values((await reopened.store.read()).device.meta.journalMigrationEntries), claims.map((claim) => claim.claimId));
  assert.equal(data.length, 0);
  reopened.observe(SCOPE); watchClaims(reopened);
  env.transport.account = 'A'; await reopened.start(); await until(() => reopened.leader);
  await reopened.signIn('A'); await converge(reopened);
  assert.equal(reopened.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'one copy');
  data.setItem(key, JSON.stringify({ [day]: entry('one copy', true, false),
    [nextDay]: { ...entry('new contribution', true, false), page: { ...doc('new contribution', nextDay), stamp: '100:0:legacy' } },
    '2026-09-29': { ...entry('cached only', false), page: { ...doc('cached only', '2026-09-29'), stamp: '100:0:legacy' } } }));
  await migratePages(reopened, data);
  assert.equal(reopened.device.anonReplica().entries(SCOPE).length, 1);
  assert.equal(reopened.device.anonReplica().entries(SCOPE)[0].intent.cmd.args.body, 'cached only');
  assert.equal(reopened.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'one copy');
  reopened.close();
});

test('migration rollback retains every source when a document is invalid or the durable write fails', async () => {
  const { engine } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': JSON.stringify({ [day]: entry('keep this'), invalid: entry('bad day') }) });
  await assert.rejects(migratePages(engine, data));
  assert.equal(data.length, 1); assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
  assert.equal(engine.device.meta.journalMigrationEntries, undefined);
  data.setItem('wm.journal.v2.pages.anon', JSON.stringify({ [day]: entry('keep this') }));
  const transact = engine.store.transact;
  engine.store.transact = async () => { throw new Error('quota'); };
  await assert.rejects(migratePages(engine, data));
  assert.equal(data.length, 1); assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
  engine.store.transact = transact;
  assert.equal((await engine.store.read()).device.meta.journalMigrationEntries, undefined);
  engine.close();
});

test('unattributable legacy pages stay quarantined through binding and restore with receipt-protected claims', async () => {
  const { engine, env } = await setup();
  await migratePages(engine, storage({ 'wm.journal.pages': JSON.stringify({ [day]: entry('unowned') }) }));
  assert.equal(unclaimedPages(engine).length, 1);
  assert.equal(pagesOf(engine).length, 0);
  env.transport.account = 'A'; await engine.signIn('A');
  assert.equal(unclaimedPages(engine).length, 1);
  assert.equal(await restoreUnclaimedPages('A', engine), 1);
  assert.equal(unclaimedPages(engine).length, 0);
  watchClaims(engine); await converge(engine);
  assert.equal(pagesOf(engine)[0].body, 'unowned');
  engine.close();
});

test('Keep hides journal pending edits from another account and resumes them only for their owner', async () => {
  const { engine, env } = await setup();
  await savePage(engine, doc('claim'));
  env.transport.account = 'A'; await engine.signIn('A');
  await savePage(engine, doc('edit A')); engine.setOnline(false);
  const question = await engine.beginSignOut();
  assert.equal(question.unsent, 2);
  await engine.finishSignOut({ choice: 'keep', counted: question.counted });
  assert.equal(pagesOf(engine).length, 0);
  env.transport.account = 'B'; await engine.signIn('B');
  assert.equal(pagesOf(engine).length, 0);
  await engine.finishSignOut({ choice: 'keep' });
  env.transport.account = 'A'; await engine.signIn('A');
  assert.equal(pagesOf(engine)[0].body, 'edit A');
  engine.close();
});

test('unread owed text survives a newer cached stamp while v1/v2 sources overlap', async () => {
  const { engine } = await setup();
  await migratePages(engine, storage({
    'wm.journal.pages.u.A': JSON.stringify({ [day]: entry('cached older prose', false, true, '1000:0:legacy') }),
    'wm.journal.v2.pages.u.A': JSON.stringify({ [day]: entry('unsent contribution', true, false, '') }),
  }));
  const command = engine.device.dormantOf('A').entries(SCOPE)[0].intent.cmd;
  assert.equal(command.name, 'journal.claimPage');
  assert.equal(command.args.body, 'unsent contribution');
  engine.close();
});

test('a server-refused document survives reload and a corrected save retires its notice', async () => {
  const { engine, env } = await setup();
  env.transport.account = 'A'; await engine.signIn('A');
  await savePage(engine, doc('seed')); await converge(engine);
  const body = 'x'.repeat(131073);
  await savePage(engine, doc(body));
  await converge(engine);
  assert.equal(engine.observe(SCOPE).getSnapshot().notices.filter((notice) => !notice.dismissed).length, 1);
  assert.equal(pagesOf(engine)[0].body, body);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(pagesOf(reopened)[0].body, body);
  await reopened.start(); await until(() => reopened.leader);
  await savePage(reopened, doc('shorter correction'));
  await converge(reopened);
  assert.equal(pagesOf(reopened)[0].body, 'shorter correction');
  assert.equal(reopened.observe(SCOPE).getSnapshot().notices.filter((notice) => !notice.dismissed).length, 0);
  reopened.close();
});

test('a refused claim correction is durable, survives failed retries and joins unseen account prose', async () => {
  const { engine, env } = await setup();
  env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
  await savePage(engine, doc('unseen account prose')); await converge(engine);
  engine.setOnline(false); await engine.finishSignOut({ choice: 'keep' });
  await engine.signIn('A');
  assert.equal(engine.observe(SCOPE).getSnapshot().firstPullComplete, false);
  const transport = env.transport.request;
  env.transport.request = async (endpoint, request) => {
    if (endpoint === 'pull') throw new Error('stalled account read');
    return transport(endpoint, request);
  };
  await savePage(engine, doc('x'.repeat(131073)));
  const obsolete = engine.device.activeReplica.entries(SCOPE)[0].intent.cmd.args.claimId;
  engine.setOnline(true); await engine.send();
  await until(() => engine.observe(SCOPE).getSnapshot().notices.some((notice) => notice.code === 'too-large'));
  assert.equal(engine.device.activeReplica.confirmedRow(SCOPE, 'page', day), undefined);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options); watchClaims(reopened);
  await reopened.start(); await until(() => reopened.leader);
  const transact = reopened.store.transact;
  reopened.store.transact = async () => { throw new Error('quota'); };
  await assert.rejects(savePage(reopened, doc('correction')));
  reopened.store.transact = transact;
  assert.equal(reopened.device.activeReplica.deviceRows('journal')[`pendingClaim:${obsolete}`].refusal, 'too-large');
  assert.equal(reopened.observe(SCOPE).getSnapshot().notices.filter((notice) => !notice.dismissed).length, 1);
  await assert.rejects(savePage(reopened, doc('x'.repeat(2200000))), /journal-local-refusal/);
  assert.equal(reopened.device.activeReplica.deviceRows('journal')[`pendingClaim:${obsolete}`].refusal, 'too-large');
  await savePage(reopened, { ...doc('correction'), mood: 4, energy: 7 });
  const corrected = reopened.device.activeReplica.entries(SCOPE).find((row) => row.intent.cmd?.name === 'journal.claimPage').intent.cmd.args;
  assert.notEqual(corrected.claimId, obsolete);
  assert.deepEqual({ ...corrected, claimId: undefined }, { ...doc('correction'), mood: 4, energy: 7, claimId: undefined });
  const persisted = (await reopened.store.read()).device.activeReplica;
  assert.equal(persisted.deviceRows('journal')[`pendingClaim:${obsolete}`], undefined);
  assert.equal(persisted.deviceRows('journal')[`pendingClaim:${corrected.claimId}`].latest.body, 'correction');
  assert.equal(persisted.notices.filter((notice) => !notice.dismissed).length, 0);
  reopened.close();
  const resumed = await BrowserSyncEngine.open(env.options); watchClaims(resumed);
  assert.equal(pagesOf(resumed)[0].body, 'correction');
  env.transport.request = transport;
  await resumed.start(); await until(() => resumed.leader); await converge(resumed);
  assert.deepEqual(pagesOf(resumed).map(({ body, mood, energy }) => ({ body, mood, energy })),
    [{ body: 'unseen account prose\n\ncorrection', mood: 4, energy: 7 }]);
  assert.equal(Object.keys(resumed.device.activeReplica.deviceRows('journal')).some((key) => key.startsWith('pendingClaim:')), false);
  resumed.close();
});

test('a locally oversized anonymous replacement survives reload without retiring its earlier claim', async () => {
  const { engine, env } = await setup();
  await savePage(engine, doc('earlier draft'));
  const body = 'x'.repeat(2200000);
  await assert.rejects(savePage(engine, doc(body)), /journal-local-refusal/);
  assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  assert.equal(pagesOf(engine)[0].body, body);
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options);
  assert.equal(pagesOf(reopened)[0].body, body);
  await savePage(reopened, doc('valid replacement'));
  assert.equal(pagesOf(reopened)[0].body, 'valid replacement');
  assert.equal(reopened.device.activeReplica.entries(SCOPE).length, 1);
  assert.equal(reopened.observe(SCOPE).getSnapshot().notices.filter((notice) => !notice.dismissed).length, 0);
  reopened.close();
});

test('keeping the first page leaves its scale invitation due until an answer or dismissal', async () => {
  const { engine, env } = await setup();
  const page = { ...doc('first page'), mood: null };
  env.transport.account = 'A'; await engine.signIn('A');
  await savePage(engine, page); await converge(engine);
  await savePage(engine, { ...page, body: 'more words' });
  let state = engine.observe(SCOPE).getSnapshot().drawn.find((row) => row.t === 'journalState');
  assert.equal(state.f.firstPage[0], 'retired');
  assert.notEqual(state.f.scales?.[0], 'retired');
  await savePage(engine, { ...page, mood: 0 });
  await converge(engine);
  state = engine.observe(SCOPE).getSnapshot().drawn.find((row) => row.t === 'journalState');
  assert.equal(state.f.scales[0], 'retired');
  engine.close();
});

test('writing before the first account pull joins unseen prose instead of replacing it', async () => {
  const { engine, env } = await setup();
  env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
  await savePage(engine, doc('already in the account')); await converge(engine);
  engine.setOnline(false); await engine.finishSignOut({ choice: 'keep' });
  await engine.signIn('A');
  assert.equal(engine.observe(SCOPE).getSnapshot().firstPullComplete, false);
  assert.equal(pagesOf(engine).length, 0);
  await savePage(engine, doc('written before the read'));
  assert.equal(engine.device.activeReplica.entries(SCOPE)[0].intent.cmd.name, 'journal.claimPage');
  watchClaims(engine); engine.setOnline(true); await converge(engine);
  assert.equal(pagesOf(engine)[0].body, 'already in the account\n\nwritten before the read');
  engine.close();
});

for (const order of ['pull-before-result', 'result-before-pull']) test(`engine claim receipt reconciles newer text: ${order}`, async () => {
  const { engine, env } = await setup();
  env.transport.account = 'A'; await engine.signIn('A'); await until(() => engine.leader);
  await savePage(engine, doc('frozen contribution'));
  const transport = env.transport.request;
  let reply, release;
  env.transport.request = async (endpoint, request) => {
    const answer = await transport(endpoint, request);
    if (endpoint !== 'push' || reply) return answer;
    reply = answer;
    return new Promise((resolve) => { release = () => resolve(answer); });
  };
  const sending = engine.send(); await until(() => !!release);
  await savePage(engine, doc('newer edit'));
  if (order === 'pull-before-result') {
    engine.kickPull(); await engine.pull();
    assert.equal(engine.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'frozen contribution');
    assert.equal(Object.values(engine.device.activeReplica.deviceRows('journal')).find((row) => row?.claimId).claimResult, null);
    release(); await sending;
    await until(() => engine.device.activeReplica.entries(SCOPE).some((entry) => entry.intent.cmd?.name === 'journal.savePage'));
    await converge(engine);
    assert.equal(engine.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'newer edit');
    engine.close();
  } else {
    release(); await sending;
    const pending = Object.values((await engine.store.read()).device.activeReplica.deviceRows('journal')).find((row) => row?.claimId);
    assert.deepEqual(pending.claimResult, { seq: reply.response.body.results[0].seq, epoch: 'ep-1' });
    engine.close();
    const reopened = await BrowserSyncEngine.open(env.options); watchClaims(reopened);
    await reopened.start(); await until(() => reopened.leader);
    await converge(reopened);
    assert.equal(reopened.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'newer edit');
    assert.equal(Object.values(reopened.device.activeReplica.deviceRows('journal')).some((row) => row?.claimId), false);
    reopened.close();
  }
});
