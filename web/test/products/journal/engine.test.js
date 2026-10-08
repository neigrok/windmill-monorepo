import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { adoptDeviceRows, pendingClaimWork, recoveredDrafts, retireInvitation } from '../../../src/products/journal/pages.js';
import { EditorDraft } from '../../../src/products/journal/domain/writing.js';
import { syncSession } from '../../../src/platform/sync/session.js';
import { ReconcileClaim } from '../../../src/products/journal/domain/writing.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { FixedZone } from '../../../src/platform/domain-kit/time.js';
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
async function setup({ watch = true } = {}) {
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
  if (watch) watchClaims(engine);
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
  assert.deepEqual(await migratePages(engine, data), { complete: false });
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
  assert.deepEqual(await migratePages(engine, data), { complete: false });
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

test('migration keeps malformed entries and failed writes retryable while valid entries remain available', async () => {
  const { engine } = await setup();
  const data = storage({ 'wm.journal.v2.pages.anon': JSON.stringify({ [day]: entry('keep this'), invalid: entry('bad day') }) });
  assert.deepEqual(await migratePages(engine, data), { complete: false });
  assert.equal(data.length, 1); assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  assert.equal(pagesOf(engine)[0].body, 'keep this');
  const receipts = structuredClone(engine.device.meta.journalMigrationEntries);
  data.setItem('wm.journal.v2.pages.anon', JSON.stringify({ [day]: entry('new writing') }));
  const transact = engine.store.transact;
  engine.store.transact = async () => { throw new Error('quota'); };
  assert.deepEqual(await migratePages(engine, data), { complete: false });
  assert.equal(data.length, 1); assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  engine.store.transact = transact;
  assert.deepEqual((await engine.store.read()).device.meta.journalMigrationEntries, receipts);
  engine.close();
});

test('blocked legacy storage does not reject journal preparation', async () => {
  const { engine } = await setup({ watch: false });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    get() { throw new DOMException('blocked test storage', 'SecurityError'); } });
  try { assert.deepEqual(await migratePages(engine), { complete: false }); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
    engine.close();
  }
});

test('migration preserves a distinct losing same-day source as recoverable writing', async () => {
  const { engine } = await setup({ watch: false });
  const data = storage({
    'wm.journal.pages.anon': JSON.stringify({ [day]: entry('earlier source writing', true, false, '90:0:legacy') }),
    'wm.journal.v2.pages.anon': JSON.stringify({ [day]: entry('newer source writing', true, false, '100:0:legacy') }),
  });
  try {
    assert.deepEqual(await migratePages(engine, data), { complete: true });
    assert.equal(data.length, 0);
    assert.equal(pagesOf(engine)[0].body, 'newer source writing');
    assert.deepEqual(recoveredDrafts(engine).map(({ day, body }) => ({ day, body })), [{ day, body: 'earlier source writing' }]);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
    await migratePages(engine, data);
    assert.equal(recoveredDrafts(engine).length, 1);
  } finally { engine.close(); }
});

test('a refused cross-day carry preserves the original dated draft as well as the new input', async () => {
  const { engine } = await setup({ watch: false });
  const original = new EditorDraft({ day: '2026-09-26', document: doc('old draft '.repeat(16000)) });
  try {
    await engine.write(null, (device) => { device.activeReplica.deviceRows('journal')[EditorDraft.key] = original.json; }, [SCOPE]);
    const body = `today\n\n${original.document.body}`;
    await assert.rejects(savePage(engine, doc(body), engine.activeReplica(), {}, original.json), /journal-local-refusal/);
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, body);
    assert.deepEqual(recoveredDrafts(engine).map(({ day, body }) => ({ day, body })), [{ day: original.day.text, body: original.document.body }]);
  } finally { engine.close(); }
});

test('a changed legacy source after blocked cleanup never appends a replacement snapshot twice', async () => {
  const { engine, env } = await setup();
  const key = 'wm.journal.v2.pages.anon';
  const data = storage({ [key]: JSON.stringify({ [day]: entry('original words', true, false) }) });
  data.removeItem = () => { throw new Error('blocked source cleanup'); };
  try {
    assert.deepEqual(await migratePages(engine, data), { complete: false });
    data.setItem(key, JSON.stringify({ [day]: entry('corrected words', true, false, '101:0:legacy') }));
    data.removeItem = (key) => data.data.delete(key);
    assert.deepEqual(await migratePages(engine, data), { complete: true });
    assert.deepEqual(engine.device.activeReplica.entries(SCOPE).map((row) => row.intent.cmd.args.body), ['original words']);
    assert.deepEqual(recoveredDrafts(engine).map(({ day, body }) => ({ day, body })), [{ day, body: 'corrected words' }]);
    env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, 'original words');
    assert.equal(recoveredDrafts(engine)[0].body, 'corrected words');
  } finally { engine.close(); }
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

test('legacy oversized writing remains editable while valid pages migrate and first open completes', async () => {
  const { engine, env } = await setup({ watch: false });
  engine.close();
  const body = 'legacy writing '.repeat(10_000);
  const data = storage({ 'wm.journal.v2.pages.anon': JSON.stringify({
    [day]: entry(body, true, false),
    '2026-09-26': { ...entry('valid older page', true, false), page: { ...doc('valid older page', '2026-09-26'), stamp: '100:0:legacy' } },
  }) });
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  const session = new syncSession.constructor();
  try {
    await session.open({ ...env.options, prepare: (opened) => migratePages(opened, data) });
    assert.equal(session.snapshot.ready, true);
    assert.equal(session.snapshot.error, false);
    assert.equal(session.engine.closed, false);
    assert.equal(data.length, 0);
    assert.deepEqual(pagesOf(session.engine).map(({ day, body }) => ({ day, body })), [
      { day: '2026-09-26', body: 'valid older page' }, { day, body },
    ]);
    assert.deepEqual(session.engine.device.activeReplica.entries(SCOPE).map((row) => row.intent.cmd.args.body), ['valid older page']);
    await savePage(session.engine, doc('corrected legacy writing'));
    assert.equal(pagesOf(session.engine).find((page) => page.day === day).body, 'corrected legacy writing');
    assert.deepEqual(recoveredDrafts(session.engine).map(({ day, body: writing }) => ({ day, body: writing })), [{ day, body }]);
  } finally {
    session.engine?.close();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('quarantine restores an oversized page for correction without blocking valid writing or repeating it', async () => {
  const { engine, env } = await setup({ watch: false });
  const body = 'quarantined writing '.repeat(8_000);
  try {
    await migratePages(engine, storage({ 'wm.journal.pages': JSON.stringify({ [day]: entry(body) }) }));
    env.transport.account = 'A'; await engine.signIn('A');
    assert.equal(await restoreUnclaimedPages('A', engine), 1);
    assert.equal(unclaimedPages(engine).length, 0);
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, body);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
    assert.equal(await restoreUnclaimedPages('A', engine), 0);
    await savePage(engine, doc('corrected quarantined writing'));
    assert.equal(pagesOf(engine).find((page) => page.day === day).body, 'corrected quarantined writing');
  } finally { engine.close(); }
});

test('sign-in adopts an offline editor-only draft into the account without an outbox entry', async () => {
  const { engine, env } = await setup({ watch: false });
  const body = 'D'.repeat(131073);
  try {
    engine.setOnline(false);
    await assert.rejects(savePage(engine, doc(body)), /journal-local-refusal/);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
    env.transport.account = 'A';
    assert.equal((await engine.signIn('A')).complete, true);
    assert.equal(engine.device.activeReplica.meta.account, 'A');
    assert.equal(pagesOf(engine).find((page) => page.day === day)?.body, body);
    engine.close();
    const reopened = await BrowserSyncEngine.open(env.options);
    try { assert.equal(pagesOf(reopened).find((page) => page.day === day)?.body, body); }
    finally { reopened.close(); }
  } finally { engine.close(); }
});

test('returning sign-in preserves both account and anonymous drafts when their device keys collide', async () => {
  const { engine, env } = await setup({ watch: false });
  const accountBody = 'A'.repeat(131073), anonymousBody = 'B'.repeat(131073);
  try {
    env.transport.account = 'A'; await engine.signIn('A');
    await assert.rejects(savePage(engine, doc(accountBody)), /journal-local-refusal/);
    await engine.finishSignOut({ choice: 'keep' });
    await savePage(engine, doc('anonymous seed'));
    await assert.rejects(savePage(engine, doc(anonymousBody)), /journal-local-refusal/);
    assert.equal((await engine.signIn('A', { decisions: { journal: 'add' } })).complete, true);
    assert.equal(pagesOf(engine).find((page) => page.day === day)?.body, accountBody);
    assert.deepEqual(recoveredDrafts(engine).map(({ day, body }) => ({ day, body })), [{ day, body: anonymousBody }]);
    const persisted = (await engine.store.read()).device;
    assert.ok(JSON.stringify(persisted).includes(accountBody));
    assert.ok(JSON.stringify(persisted).includes(anonymousBody));
    engine.close();
    const reopened = await BrowserSyncEngine.open(env.options);
    try { assert.equal(recoveredDrafts(reopened)[0]?.body, anonymousBody); }
    finally { reopened.close(); }
  } finally { engine.close(); }
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
  // Recover a command retained by an older client, before local body validation.
  await engine.commit(SCOPE, [], { cmd: { name: 'journal.savePage', args: { ...doc(body),
    stamp: { ms: env.timers.time + 1, counter: 0, actor: 'legacy' } } } });
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

test('a refused claim retains its receipt and edits through failed commits and restart without appending again', async () => {
  const { engine, env } = await setup();
  env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
  await savePage(engine, doc('unseen account prose')); await converge(engine);
  engine.setOnline(false); await engine.finishSignOut({ choice: 'keep' });
  await engine.signIn('A');
  const transport = env.transport.request;
  env.transport.request = async (endpoint, request) => {
    if (endpoint === 'pull') throw new Error('stalled account read');
    return transport(endpoint, request);
  };
  // A pending command written by the old client remains a recovery obligation.
  const claimId = 'legacy-refused-claim';
  const base = { body: 'x'.repeat(131073), mood: 0, energy: null, source: 'typed' };
  const key = `pendingClaim:${claimId}`;
  await engine.commit(SCOPE, [], { cmd: { name: 'journal.claimPage', args: { day, ...base, claimId } },
    local: { [key]: { day, claimId, base, latest: base, touched: [], retirements: { firstPage: 'retired' }, claimResult: null, refusal: null } } });
  engine.setOnline(true); await engine.send();
  await until(() => engine.observe(SCOPE).getSnapshot().notices.some((notice) => notice.code === 'too-large'));
  engine.close();
  const reopened = await BrowserSyncEngine.open(env.options); watchClaims(reopened);
  await reopened.start(); await until(() => reopened.leader);
  const before = structuredClone(reopened.device.activeReplica.deviceRows('journal')[key]);
  const transact = reopened.store.transact;
  reopened.store.transact = async () => { throw new Error('quota'); };
  await assert.rejects(savePage(reopened, doc('correction')));
  reopened.store.transact = transact;
  assert.deepEqual(reopened.device.activeReplica.deviceRows('journal')[key], before);
  await assert.rejects(savePage(reopened, doc('x'.repeat(2200000))), /journal-local-refusal/);
  assert.deepEqual(reopened.device.activeReplica.deviceRows('journal')[key], before);
  await savePage(reopened, { ...doc('correction'), mood: 4, energy: 7 });
  const persisted = (await reopened.store.read()).device.activeReplica;
  assert.equal(persisted.entries(SCOPE).length, 0, 'editing a refused receipt queues no fresh claim');
  assert.deepEqual(persisted.deviceRows('journal')[key], { ...before,
    latest: { body: 'correction', mood: 4, energy: 7, source: 'typed' }, touched: ['body', 'energy', 'mood'],
    retirements: { firstPage: 'retired', placeholder: 'retired', privacyLine: 'retired', scales: 'retired' } });
  assert.equal(persisted.deviceRows('journal')[EditorDraft.key], undefined);
  assert.equal(persisted.notices.filter((notice) => !notice.dismissed).length, 1, 'the unsaved claim stays visible');
  reopened.close();
  const resumed = await BrowserSyncEngine.open(env.options); watchClaims(resumed);
  assert.equal(pagesOf(resumed)[0].body, 'correction');
  env.transport.request = transport;
  await resumed.start(); await until(() => resumed.leader); await converge(resumed);
  assert.equal(resumed.device.activeReplica.confirmedRow(SCOPE, 'page', day).x.body.text, 'unseen account prose');
  assert.equal(resumed.device.activeReplica.deviceRows('journal')[key].latest.body, 'correction');
  assert.equal(resumed.device.activeReplica.deviceRows('journal')[key].claimId, claimId);
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

for (const anonymous of [true, false]) test(`a post-decision storage abort preserves ${anonymous ? 'anonymous supersession' : 'the bound content clock and document'}`, async () => {
  const { engine, env } = await setup();
  try {
    if (!anonymous) {
      env.transport.account = 'A'; await engine.signIn('A'); await converge(engine);
    }
    await savePage(engine, doc('durable draft'));
    if (!anonymous) await converge(engine);
    engine.setOnline(false);
    const capture = async () => {
      const replica = (await engine.store.read()).device.activeReplica;
      return { rows: structuredClone(replica.deviceRows('journal')), entries: structuredClone(replica.entries(SCOPE)), hlc: replica.meta.hlc };
    };
    const before = await capture();
    const transact = engine.store.transact.bind(engine.store);
    engine.store.transact = (change, options) => {
      engine.store.transact = transact;
      return transact((device) => { change(device); throw new DOMException('quota', 'QuotaExceededError'); }, options);
    };
    const latest = { ...doc('latest input'), mood: null, energy: 0 };
    await assert.rejects(savePage(engine, latest), (error) => error.kind === 'store');
    assert.deepEqual(await capture(), before, 'command, prediction, state and clocks roll back together');
    assert.equal(pagesOf(engine)[0].body, 'durable draft');
    await savePage(engine, latest);
    const after = await capture();
    const command = after.entries.at(-1).intent.cmd;
    assert.equal(command.args.body, 'latest input');
    if (anonymous) {
      assert.equal(after.entries.length, 1);
      assert.equal(Object.keys(after.rows).filter((key) => key.startsWith('pendingClaim:')).length, 1);
      assert.notEqual(command.args.claimId, before.entries[0].intent.cmd.args.claimId);
    } else {
      const stamp = command.args.stamp;
      assert.deepEqual(after.rows.contentClock, { ms: stamp.ms, counter: stamp.counter });
      assert.deepEqual(after.entries.at(-1).predict[0].f.documentStamp[0], stamp);
    }
    engine.close();
    const reopened = await BrowserSyncEngine.open(env.options);
    assert.deepEqual(pagesOf(reopened).map(({ body, mood, energy }) => ({ body, mood, energy })),
      [{ body: latest.body, mood: null, energy: 0 }]);
    reopened.close();
  } finally { engine.close(); }
});

test('reconciliation rolls back pending removal and its clock write after a storage abort, then saves once', async () => {
  const { engine, env } = await setup({ watch: false });
  try {
    await savePage(engine, doc('frozen'));
    env.transport.account = 'A'; await engine.signIn('A');
    await savePage(engine, { ...doc('newer writing'), mood: null });
    await converge(engine);
    engine.setOnline(false);
    const before = structuredClone(engine.device.activeReplica.deviceRows('journal'));
    const pending = Object.values(before).find((row) => row?.claimId);
    assert.ok(pending.claimResult);
    const runner = new ActionRunner(new EngineReplica(engine), journalRegistry, new FixedZone(0));
    const action = new ReconcileClaim({ day, claimId: pending.claimId });
    const transact = engine.store.transact.bind(engine.store);
    engine.store.transact = (change, options) => {
      engine.store.transact = transact;
      return transact((device) => { change(device); throw new DOMException('quota', 'QuotaExceededError'); }, options);
    };
    await assert.rejects(runner.run(action), (error) => error.kind === 'store');
    assert.deepEqual((await engine.store.read()).device.activeReplica.deviceRows('journal'), before);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
    const result = await runner.run(action);
    assert.equal(result.kind, 'committed');
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
    assert.equal(engine.device.activeReplica.deviceRows('journal')[`pendingClaim:${pending.claimId}`], undefined);
    engine.setOnline(true); await converge(engine);
    const row = engine.device.activeReplica.confirmedRow(SCOPE, 'page', day);
    assert.equal(row.x.body.text, 'newer writing');
    assert.equal(row.f.mood[0], null);
    assert.equal((await runner.run(action)).kind, 'unchanged');
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, 0);
  } finally { engine.close(); }
});

test('Not now retires only the invitation and queues no empty page', async () => {
  const { engine } = await setup();
  try {
    await retireInvitation(engine, 'scales');
    assert.deepEqual(pagesOf(engine), []);
    const row = engine.observe(SCOPE).getSnapshot().drawn.find((row) => row.t === 'journalState');
    assert.equal(row.f.scales[0], 'retired');
    assert.equal(row.f.placeholder?.[0] ?? 'pending', 'pending');
    assert.ok(engine.device.activeReplica.entries(SCOPE).every((entry) => entry.intent.cmd === undefined));
  } finally { engine.close(); }
});

test('pending writing takes precedence over an older save refusal notice', async () => {
  const { engine } = await setup();
  try {
    await savePage(engine, doc('newer contribution'));
    await engine.write(null, (device) => {
      device.activeReplica.notices.push({ id: 'notice:old/0', scope: SCOPE, code: 'too-large', at: 0,
        content: { cmd: { name: 'journal.savePage', args: { ...doc('older refused writing'),
          stamp: { ms: 1, counter: 0, actor: 'legacy' } } } } });
    }, [SCOPE]);
    assert.equal(pagesOf(engine)[0].body, 'newer contribution');
    await savePage(engine, { ...doc('newer contribution'), mood: 4 });
    assert.equal(pagesOf(engine)[0].body, 'newer contribution');
  } finally { engine.close(); }
});
