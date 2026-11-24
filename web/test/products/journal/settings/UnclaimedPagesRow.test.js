import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { OldStores, dropUnclaimedPages, restoreUnclaimedPages, unclaimedPages } from '../../../../src/products/journal/carry.js';
import { SCOPE } from '../../../../src/products/journal/pages.js';
import { environment } from '../../../platform/sync/fakes.js';
import { journalRegistry } from '../../../platform/sync/oracle-adapters/journal.js';
import { elementsOf, loadScreen, renderHook, textOf } from '../../gym/harness.mjs';

const { UnclaimedPagesRow } = await loadScreen('products/journal/settings/UnclaimedPagesRow.jsx');
const page = { day: '2026-09-27', body: 'private unsent words', mood: null, energy: null, source: 'typed', stamp: '' };
const buttons = (run) => elementsOf(run.tree).filter((element) => typeof element.props.onClick === 'function');
const claims = (engine) => engine.device.activeReplica.entries(SCOPE).flatMap((each) => (each.intent.cmd ? [each.intent.cmd.args] : []));

// The browser's storage holding `pages` where the bundle before the engine kept the pages it could not attribute, and an
// engine bound to account A, both the row's.
async function setup(t, pages = [page]) {
  const data = new Map(pages.length ? [['wm.journal.v2.pages.unclaimed',
    JSON.stringify(Object.fromEntries(pages.map((each) => [each.day, { page: each, needsPush: true, read: false }])))]] : []);
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) } });
  const env = environment();
  env.options.registry = journalRegistry;
  const engine = await BrowserSyncEngine.open(env.options);
  const previous = syncSession.engine;
  syncSession.engine = engine;
  t.after(() => {
    syncSession.engine = previous;
    engine.close();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  });
  await engine.write(null, (device) => {
    device.activeReplica.meta.state = 'bound';
    device.activeReplica.meta.account = 'A';
    device.activeReplica.meta.serverEpoch = 'ep-1';
  });
  const run = renderHook(t, () => UnclaimedPagesRow({ account: 'A' }));
  return { env, engine, data, run };
}

test('no unattributed pages draws nothing', async (t) => {
  const { run } = await setup(t, []);
  assert.equal(run.tree, null);
});

for (const action of ['restored', 'discarded']) {
  test(`pages ${action} in another tab are no longer offered or claimed as still here`, async (t) => {
    const { env, engine, run } = await setup(t);
    assert.match(textOf(run.tree), /2026-09-27 · 3 words/);
    assert.doesNotMatch(textOf(run.tree), /private unsent words/);
    const other = await BrowserSyncEngine.open(env.options);
    t.after(() => other.close());
    if (action === 'restored') assert.equal(await restoreUnclaimedPages('A', { engine: other, track: () => {} }), 1);
    else assert.equal(dropUnclaimedPages({ track: () => {} }), 1);
    await engine.refresh();
    const owed = claims(engine).length;

    await buttons(run)[0].props.onClick();

    assert.equal(textOf(run.tree), 'These pages are no longer waiting to be restored. Another tab may have restored or discarded them.');
    assert.deepEqual(buttons(run), []);
    assert.deepEqual(unclaimedPages(), []);
    assert.equal(claims(engine).length, owed);
  });
}

test('restoring pages shows the receipt and removes the stale offer', async (t) => {
  const { engine, data, run } = await setup(t);
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree), 'Restored 1 page into your journal.');
  assert.deepEqual(buttons(run), []);
  assert.deepEqual(unclaimedPages(), []);
  assert.equal(data.size, 0);
  assert.deepEqual(claims(engine).map(({ claimId, ...args }) => args), [{ day: page.day, body: page.body, mood: null, energy: null, source: 'typed' }]);
});

test('discarding pages shows the receipt, removes the stale offer and writes nothing to the engine', async (t) => {
  const { engine, data, run } = await setup(t);
  const revision = engine.revision;
  await buttons(run)[1].props.onClick();
  assert.equal(textOf(run.tree), 'Deleted from this browser.');
  assert.deepEqual(buttons(run), []);
  assert.equal(data.size, 0);
  assert.equal(engine.revision, revision);
  assert.deepEqual(engine.device.activeReplica.entries(SCOPE), []);
});

test('a failed restore keeps the pages and offers a retry', async (t) => {
  const { engine, data, run } = await setup(t);
  const transact = engine.store.transact;
  engine.store.transact = async () => { throw new Error('storage denied'); };
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree).endsWith('The pages could not be restored just now. Try again.'), true);
  assert.equal(unclaimedPages().length, 1);
  assert.equal(data.size, 1);
  assert.equal(buttons(run)[0].props.disabled, false);
  engine.store.transact = transact;
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree), 'Restored 1 page into your journal.');
});

test('a restore another tab finishes meanwhile writes nothing twice and says the pages no longer wait', async (t) => {
  const { env, engine, run } = await setup(t);
  const other = await BrowserSyncEngine.open(env.options);
  t.after(() => other.close());
  const commitAct = engine.commitAct.bind(engine);
  t.mock.method(engine, 'commitAct', async (...args) => {
    await restoreUnclaimedPages('A', { engine: other, stores: new OldStores(), track: () => {} });
    return commitAct(...args);
  });

  await buttons(run)[0].props.onClick();

  assert.equal(textOf(run.tree), 'These pages are no longer waiting to be restored. Another tab may have restored or discarded them.');
  assert.deepEqual(unclaimedPages(), []);
  await engine.refresh();
  assert.equal(claims(engine).length, 1);
});
