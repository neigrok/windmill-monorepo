import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSession } from '../../../src/platform/sync/session.js';
import { useTrainingLog } from '../../../src/products/gym/useTrainingLog.js';
import { browserWith, confirmed, gymAccount, renderHook, settle } from './harness.mjs';

const stamp = '1000:0:r_aaaaaaaaaaaa';
const row = (t, id, fields) => ({ t, id, born: stamp, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])) });
function log(t, rows = []) {
  browserWith();
  let records = { replica: 'bound', drawn: rows, stored: rows, notices: [], undoOffers: [], firstPullComplete: true };
  const observation = { subscribe: () => () => {}, getSnapshot: () => records };
  const engine = { activeReplica: () => 'bound', observe: () => observation,
    getSnapshot: () => ({ state: 'bound' }), observeEngine: () => () => {} };
  const session = { ready: true, signedIn: true, engine };
  t.mock.method(syncSession, 'getSnapshot', () => session);
  const view = renderHook(t, () => useTrainingLog());
  return { view, update: (change) => { records = { ...records, ...change }; view.redraw(); }, engine };
}

test('engine observations mirror a phone session, sets and finish without REST or polling', (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async () => { calls.push('fetch'); throw new Error('REST read'); });
  const { view, update } = log(t);
  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.session, null);
  const session = row('session', 'sessionPhone', { startedAt: Date.now() - 1000 });
  update({ drawn: [session], stored: [session] });
  assert.equal(view.log.session.id, 'sessionPhone');
  const set = { ...row('set', 'setPhone00', { sessionId: 'sessionPhone', exerciseId: 'bench-press', weightKg: 60, reps: 5, completedAt: Date.now() }), v: { setNumber: 1 } };
  update({ drawn: [session, set], stored: [session, set] });
  assert.equal(view.log.sets[0].weightKg, 60);
  const finished = { ...session, f: { ...session.f, finishedAt: [Date.now(), stamp] } };
  update({ drawn: [finished, set], stored: [finished, set] });
  assert.equal(view.log.session, null);
  assert.equal(view.log.summaries[0].workingSetCount, 1);
  assert.deepEqual(calls, []);
});

test('cached records open offline, empty first boot waits for the first pull', (t) => {
  const { view, update } = log(t);
  update({ firstPullComplete: false });
  assert.equal(view.log.phase, 'loading');
  const session = row('session', 'cachedSession', { startedAt: 1000, finishedAt: 2000 });
  update({ drawn: [session], stored: [session] });
  assert.equal(view.log.phase, 'ready');
  assert.equal(view.log.summaries[0].id, 'cachedSession');
});

test('the room holds the fifty newest sessions as a local slice that follows observations', (t) => {
  const rows = Array.from({ length: 101 }, (_, index) => row('session', `session${String(index).padStart(4, '0')}`, { startedAt: 1000 + index, finishedAt: 2000 + index }));
  const { view, update } = log(t, rows);
  assert.deepEqual([view.log.summaries.length, view.log.summaries[0].id, view.log.summaries.at(-1).id], [50, 'session0100', 'session0051']);
  const grown = [...rows, row('session', 'sessionNew00', { startedAt: 3000, finishedAt: 4000 })];
  update({ drawn: grown, stored: grown });
  assert.deepEqual([view.log.summaries.length, view.log.summaries[0].id, view.log.summaries.at(-1).id], [50, 'sessionNew00', 'session0052']);
});

test('a held delete is offered from the engine’s own offer, and Undo hands its gesture back to the engine', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  browserWith();
  const { engine, owed } = await gymAccount(t, [confirmed('note', 'note000001', { title: 'Kept', body: '', ord: 'a0' })]);
  const view = renderHook(t, () => useTrainingLog(), { live: true });
  const undone = [];
  const undo = engine.undo.bind(engine);
  t.mock.method(engine, 'undo', (gesture) => { undone.push(gesture); return undo(gesture); });
  view.log.holdDelete({ kind: 'note', id: 'note000001' });
  await settle();
  const gestureId = engine.observe('self/gym').getSnapshot().undoOffers[0].id;
  assert.deepEqual(view.log.held.map(({ key, kind, id, line, gestureId, releaseAt }) => ({ key, kind, id, line, gestureId, releaseAt })),
    [{ key: 'note:note000001', kind: 'note', id: 'note000001', line: 'Note deleted.', gestureId, releaseAt: 1_800_000_009_000 }]);
  assert.equal(view.log.transient.action.label, 'Undo');
  await view.log.transient.action.run();
  assert.deepEqual(undone, [gestureId]);
  assert.deepEqual(owed(), []);
  assert.deepEqual(view.log.held, []);
  assert.equal(view.log.transient, null);
});

test('an offer whose deadline has passed is not offered, even before the engine has released it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_009_000 });
  const note = row('note', 'note000001', { title: 'Kept', body: '', ord: 'a0' });
  const { view, update } = log(t, [note]);
  update({ undoOffers: [{ id: 'gesture1', releaseAt: 1_800_000_009_000, records: [{ t: 'note', id: 'note000001' }] }] });
  assert.deepEqual(view.log.held, []);
  assert.equal(view.log.transient, null);
});

test('a held delete this device cannot store keeps the drawn note and says the screen’s refusal', async (t) => {
  browserWith();
  const { engine, refuseWrites } = await gymAccount(t, [confirmed('note', 'note000001', { title: 'Kept', body: '', ord: 'a0' })]);
  const view = renderHook(t, () => useTrainingLog(), { live: true });
  const refused = [];
  refuseWrites();
  view.log.holdDelete({ kind: 'note', id: 'note000001', refused: (error) => { refused.push(error.kind); view.log.say('Not deleted.'); } });
  assert.equal(view.log.held.length, 1);
  await settle();
  assert.deepEqual(refused, ['store']);
  assert.equal(view.log.held.length, 0);
  assert.equal(engine.observe('self/gym').getSnapshot().drawn[0].life[0], 'alive');
  assert.equal(view.log.transient.text, 'Not deleted.');
});

test('asynchronous engine refusals remain durable and are announced once', (t) => {
  const { view, update } = log(t);
  const notices = [{ id: 'notice:one', scope: 'self/gym', code: 'stale', content: { private: 'kept only on device' } }];
  update({ notices });
  assert.match(view.log.transient.text, /could not be saved/);
  view.log.say('A later step.');
  update({ notices: [...notices] });
  assert.equal(view.log.transient.text, 'A later step.');
});

test('a stalled durable writer keeps its Undo offer and creates no clock after room exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browserWith();
  const { engine } = await gymAccount(t, [confirmed('note', 'note000001', { title: 'Kept', body: '', ord: 'a0' })]);
  const view = renderHook(t, () => useTrainingLog(), { live: true });
  let complete;
  const commit = engine.commit.bind(engine);
  t.mock.method(engine, 'commit', async (...args) => {
    await new Promise((resolve) => { complete = resolve; });
    return commit(...args);
  });
  view.log.holdDelete({ kind: 'note', id: 'note000001' });
  t.mock.timers.tick(9000);
  assert.equal(view.log.transient.action.label, 'Undo');
  view.unmount();
  complete();
  await settle();
  t.mock.timers.tick(9000);
  assert.equal(view.log.held.length, 1, 'the unmounted snapshot receives no delayed publish');
});

test('live session lookup is independent of the displayed history page', (t) => {
  const now = Date.now();
  const rows = Array.from({ length: 55 }, (_, index) => row('session', `backfill${String(index).padStart(4, '0')}`, { startedAt: now - 10000 + index, finishedAt: now - 1000 + index }));
  rows.push(row('session', 'phoneSession00', { startedAt: now - 3600_000 }));
  const { view } = log(t, rows);
  assert.equal(view.log.summaries.some((summary) => summary.id === 'phoneSession00'), false);
  assert.equal(view.log.session.id, 'phoneSession00');
});
