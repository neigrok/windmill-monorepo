import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSession } from '../../../src/platform/sync/session.js';
import { useTrainingLog } from '../../../src/products/gym/useTrainingLog.js';
import { browserWith, renderHook, settle } from './harness.mjs';

const stamp = '1000:0:r_aaaaaaaaaaaa';
const row = (t, id, fields) => ({ t, id, born: stamp, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, [value, stamp]])) });
function log(t, rows = []) {
  browserWith();
  let records = { replica: 'bound', drawn: rows, stored: rows, notices: [], firstPullComplete: true };
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

test('older history is a local slice and preserves observations while paging', (t) => {
  const rows = Array.from({ length: 101 }, (_, index) => row('session', `session${String(index).padStart(4, '0')}`, { startedAt: 1000 + index, finishedAt: 2000 + index }));
  const { view, update } = log(t, rows);
  assert.equal(view.log.summaries.length, 50);
  view.log.older.load();
  assert.equal(view.log.summaries.length, 100);
  const grown = [...rows, row('session', 'sessionNew00', { startedAt: 3000, finishedAt: 4000 })];
  update({ drawn: grown, stored: grown });
  assert.equal(view.log.summaries.length, 100);
  assert.equal(view.log.summaries[0].id, 'sessionNew00');
  view.log.older.load();
  assert.equal(view.log.summaries.length, 102);
  assert.equal(view.log.older.status, 'end');
});

test('held engine deletes persist before Undo and never call the obsolete delayed sender', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { view, engine } = log(t);
  let committed = false, undone = false, sent = false;
  engine.commit = async () => { committed = true; return { outcome: { localIds: ['gesture1/0'] }, value: null }; };
  engine.undo = async (gesture) => { assert.equal(gesture, 'gesture1'); undone = true; return true; };
  view.log.withhold({ kind: 'note', id: 'note000001', engineDeath: { type: 'note', id: 'note000001' }, line: 'Note deleted.', send: async () => { sent = true; } });
  await settle();
  assert.equal(committed, true);
  assert.equal(view.log.transient.action.label, 'Undo');
  await view.log.undoWithheld();
  assert.equal(undone, true);
  t.mock.timers.tick(9000);
  await settle();
  assert.equal(sent, false);
  assert.equal(view.log.held.length, 0);
});

test('storage failure restores a held row and displays the refusal', async (t) => {
  const { view, engine } = log(t);
  engine.commit = async () => { throw new Error('private content must not be reported'); };
  view.log.withhold({ kind: 'note', id: 'note000001', engineDeath: { type: 'note', id: 'note000001' }, line: 'Deleted.', refused: () => view.log.say('Not deleted.') });
  await settle();
  assert.equal(view.log.hidden('note').has('note000001'), false);
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
  const { view, engine } = log(t);
  let complete;
  engine.commit = () => new Promise((resolve) => { complete = resolve; });
  view.log.withhold({ kind: 'note', id: 'note000001', engineDeath: { type: 'note', id: 'note000001' }, line: 'Deleted.' });
  t.mock.timers.tick(9000);
  assert.equal(view.log.transient.action.label, 'Undo');
  view.unmount();
  complete({ outcome: { localIds: ['gesture/0'] }, value: null });
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
