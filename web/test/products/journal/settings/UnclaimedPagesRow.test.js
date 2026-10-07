import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSyncEngine } from '../../../../src/platform/sync/engine.js';
import { syncSession } from '../../../../src/platform/sync/session.js';
import { dropUnclaimedPages, restoreUnclaimedPages, unclaimedPages, SCOPE } from '../../../../src/products/journal/pages.js';
import { environment } from '../../../platform/sync/fakes.js';
import { journalRegistry } from '../../../platform/sync/oracle-adapters/journal.js';
import { elementsOf, loadScreen, renderHook, textOf } from '../../gym/harness.mjs';

const { UnclaimedPagesRow } = await loadScreen('products/journal/settings/UnclaimedPagesRow.jsx');
const page = { day: '2026-09-27', body: 'private unsent words', mood: null, energy: null, source: 'typed', stamp: '' };
const buttons = (run) => elementsOf(run.tree).filter((element) => typeof element.props.onClick === 'function');

async function setup(t, pages = [page]) {
  const env = environment();
  env.options.registry = journalRegistry;
  const engine = await BrowserSyncEngine.open(env.options);
  const previous = syncSession.engine;
  syncSession.engine = engine;
  t.after(() => { syncSession.engine = previous; engine.close(); });
  await engine.write(null, (device) => {
    device.activeReplica.meta.state = 'bound';
    device.activeReplica.meta.account = 'A';
    device.activeReplica.meta.serverEpoch = 'ep-1';
    device.meta.journalUnclaimed = pages;
  });
  const run = renderHook(t, () => UnclaimedPagesRow({ account: 'A' }));
  return { env, engine, run };
}

test('an empty quarantine draws nothing', async (t) => {
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
    if (action === 'restored') assert.equal(await restoreUnclaimedPages('A', other), 1);
    else await dropUnclaimedPages(other);
    await engine.refresh();
    const owed = engine.device.activeReplica.entries(SCOPE).length;

    await buttons(run)[0].props.onClick();

    assert.equal(textOf(run.tree), 'These pages are no longer waiting to be restored. Another tab may have restored or discarded them.');
    assert.deepEqual(buttons(run), []);
    assert.deepEqual(unclaimedPages(engine), []);
    assert.equal(engine.device.activeReplica.entries(SCOPE).length, owed);
  });
}

test('restoring pages shows the receipt and removes the stale offer', async (t) => {
  const { engine, run } = await setup(t);
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree), 'Restored 1 page into your journal.');
  assert.deepEqual(buttons(run), []);
  assert.deepEqual(unclaimedPages(engine), []);
  assert.deepEqual(engine.device.activeReplica.entries(SCOPE).map((entry) => {
    const { claimId, ...doc } = entry.intent.cmd.args;
    return doc;
  }), [{ day: page.day, body: page.body, mood: null, energy: null, source: 'typed' }]);
});

test('discarding pages shows the receipt and removes the stale offer', async (t) => {
  const { engine, run } = await setup(t);
  await buttons(run)[1].props.onClick();
  assert.equal(textOf(run.tree), 'Deleted from this browser.');
  assert.deepEqual(buttons(run), []);
  assert.deepEqual(unclaimedPages(engine), []);
  assert.deepEqual(engine.device.activeReplica.entries(SCOPE), []);
});

test('a failed restore keeps the quarantined pages and offers a retry', async (t) => {
  const { engine, run } = await setup(t);
  const transact = engine.store.transact;
  engine.store.transact = async () => { throw new Error('storage denied'); };
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree).endsWith('The pages could not be restored just now. Try again.'), true);
  assert.deepEqual(unclaimedPages(engine), [page]);
  assert.equal(buttons(run)[0].props.disabled, false);
  engine.store.transact = transact;
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree), 'Restored 1 page into your journal.');
});

test('a concurrent restore failure does not claim that the pages are still waiting here', async (t) => {
  const { env, engine, run } = await setup(t);
  const other = await BrowserSyncEngine.open(env.options);
  t.after(() => other.close());
  const write = engine.write.bind(engine);
  t.mock.method(engine, 'write', async (...args) => {
    await restoreUnclaimedPages('A', other);
    return write(...args);
  });

  await buttons(run)[0].props.onClick();

  assert.equal(textOf(run.tree).endsWith('The pages could not be restored just now. Try again.'), true);
  assert.deepEqual(unclaimedPages(other), []);
  await engine.refresh();
  assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
  await buttons(run)[0].props.onClick();
  assert.equal(textOf(run.tree), 'These pages are no longer waiting to be restored. Another tab may have restored or discarded them.');
  assert.equal(engine.device.activeReplica.entries(SCOPE).length, 1);
});
