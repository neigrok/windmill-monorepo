import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { hello } from '../../../../../packages/api-contract/sync/reference/server/pull.js';
import { ServerState } from '../../../../../packages/api-contract/sync/reference/server/state.js';
import { registry } from '../../../../src/platform/sync/schema.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const now = Date.parse('2027-01-15T12:00:00Z');
const response = hello({ state: ServerState.empty({ epoch: 'notes-delete', accounts: { A: { name: 'A' } } }),
  registry, account: 'A', serverTime: now });
const titles = Array.from({ length: 10 }, (_, index) => `Note ${index}`);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
import { registry } from '/src/platform/sync/schema.js';
import { syncSession } from '/src/platform/sync/session.js';
import { useTrainingLog } from '/src/products/gym/useTrainingLog.js';
import { Notes } from '/src/products/gym/notes/Notes.jsx';
import { Transient } from '/src/products/gym/GymApp.jsx';

window.openRoom = async ({ response, now, seed }) => {
  const timing = { send: { wall: now, mono: now, boot: 'notes' }, recv: { wall: now, mono: now, boot: 'notes' } };
  window.failures = [];
  window.engine = await BrowserSyncEngine.open({ name: 'notes-delete', registry,
    now: () => now, monotonic: () => now, document: null, window: null,
    navigator: { onLine: false, locks: navigator.locks, storage: navigator.storage },
    transport: { request: async () => ({ response, timing }) },
    telemetry: { failure: (operation) => failures.push(operation), event() {} } });
  if (seed) {
    await engine.signIn('A');
    await engine.write(null, (device) => {
      const stamp = '1:0:srv';
      for (let index = 0; index < 10; index++) {
        device.activeReplica.putConfirmed('self/gym', { t: 'note', id: 'note00000' + index,
          seq: index + 1, life: ['alive', stamp], born: stamp,
          f: { title: ['Note ' + index, stamp], body: ['', stamp], ord: ['a' + index, stamp], updatedAt: [now, stamp] } });
      }
      device.activeReplica.cursors['self/gym'] = { ...device.activeReplica.cursorOf('self/gym'), booted: true };
    }, ['self/gym']);
  }
  engine.observe('self/gym');
  await engine.start();
  syncSession.publish({ engine, ready: true, signedIn: true, online: false, error: false });
  function Room() {
    const log = useTrainingLog();
    return React.createElement(React.Fragment, null,
      React.createElement(Notes, { log }), React.createElement(Transient, { transient: log.transient }));
  }
  window.reactRoot = createRoot(document.getElementById('root'));
  reactRoot.render(React.createElement(Room));
};
window.stallDelete = (fail) => {
  const commit = engine.commit.bind(engine);
  engine.commit = async (...args) => {
    engine.commit = commit;
    await new Promise((resolve) => { window.releaseDelete = resolve; });
    if (fail) {
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = () => {
        engine.store.transact = transact;
        return Promise.reject(new DOMException('storage refused', 'QuotaExceededError'));
      };
    }
    return commit(...args);
  };
};
window.entryReady = true;
`;

let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-notes-delete-test`,
    plugins: [{ name: 'notes-delete-test',
      resolveId(id) { if (id === '/notes-delete-entry.js') return '\0notes-delete-entry'; },
      load(id) { if (id === '\0notes-delete-entry') return entry; },
      configureServer(server) {
        server.middlewares.use('/notes-delete-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Notes delete test</title><div id="root"></div><script type="module" src="/notes-delete-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', '@noble/hashes/sha256', '@noble/hashes/utils'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => {
  try { await ready; } finally { await browser?.close(); await server?.close(); }
});

async function open(context, errors, seed = true) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/notes-delete-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate((options) => openRoom(options), { response, now, seed });
  await page.getByRole('button', { name: 'Note 7', exact: true }).waitFor();
  return page;
}

async function deleteNote(page, fail = false) {
  await page.getByRole('button', { name: 'Note 7', exact: true }).click();
  await page.evaluate((fail) => stallDelete(fail), fail);
  await page.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.getByRole('heading', { name: 'Notes', exact: true }).waitFor();
}

async function assertHidden(page) {
  assert.deepEqual(await page.locator('.gym-note-row .gym-note-title').allTextContents(), titles.filter((title) => title !== 'Note 7'));
  assert.equal(await page.getByRole('button', { name: 'Note 7', exact: true }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Note title', exact: true }).count(), 0);
  assert.equal(await page.locator('.gym-notes-full').textContent(), '10 of 10 notes. Delete one to add another.');
  assert.equal(await page.getByRole('button', { name: 'Add a note', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => engine.observe('self/gym').getSnapshot().stored
    .filter((row) => row.t === 'note' && row.life[0] === 'alive').length), 10);
}

for (const beforeCommit of [true, false]) test(`Chromium: a pending note deletion hides immediately and Undo ${beforeCommit ? 'before' : 'after'} commit restores its place`, async () => {
  await ready;
  const context = await browser.newContext();
  const errors = [];
  try {
    const page = await open(context, errors);
    await deleteNote(page);
    await assertHidden(page);
    assert.equal(await page.locator('.gym-toast-slot').textContent(), 'Note deleted.Undo');
    assert.equal(await page.evaluate(() => engine.observe('self/gym').getSnapshot().undoOffers.length), 0);
    if (beforeCommit) await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.evaluate(() => releaseDelete());
    if (!beforeCommit) {
      await page.waitForFunction(() => engine.observe('self/gym').getSnapshot().undoOffers.length === 1);
      await assertHidden(page);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Note 7', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.gym-note-row .gym-note-title').allTextContents(), titles);
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.outbox.length), 0);
    await page.getByRole('button', { name: 'Note 7', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Note title', exact: true }).inputValue(), 'Note 7');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Chromium: a pending note deletion restores its row and reports when storage fails', async () => {
  await ready;
  const context = await browser.newContext();
  const errors = [];
  try {
    const page = await open(context, errors);
    await deleteNote(page, true);
    await assertHidden(page);
    await page.evaluate(() => releaseDelete());
    await page.getByRole('button', { name: 'Note 7', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.gym-note-row .gym-note-title').allTextContents(), titles);
    assert.equal(await page.locator('.gym-toast-slot').textContent(), 'That note wasn’t deleted — this device couldn’t store it.');
    assert.deepEqual(await page.evaluate(() => ({ failures, outbox: engine.device.activeReplica.outbox })),
      { failures: ['storage'], outbox: [] });
    await page.getByRole('button', { name: 'Note 7', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Note title', exact: true }).inputValue(), 'Note 7');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Chromium: a held deletion in another tab closes an open note editor and Undo restores the row', async () => {
  await ready;
  const context = await browser.newContext();
  const errors = [];
  try {
    const deleting = await open(context, errors);
    const editing = await open(context, errors, false);
    await editing.getByRole('button', { name: 'Note 7', exact: true }).click();
    await editing.getByRole('textbox', { name: 'Note body', exact: true }).fill('Unsaved edit');
    await deleting.getByRole('button', { name: 'Note 7', exact: true }).click();
    await deleting.getByRole('button', { name: 'Delete note', exact: true }).click();
    await editing.waitForFunction(() => engine.observe('self/gym').getSnapshot().undoOffers.length === 1);
    await editing.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertHidden(editing);
    await editing.getByRole('button', { name: 'Undo', exact: true }).click();
    for (const page of [deleting, editing]) {
      await page.getByRole('button', { name: 'Note 7', exact: true }).waitFor();
      assert.deepEqual(await page.locator('.gym-note-row .gym-note-title').allTextContents(), titles);
      assert.equal(await page.getByRole('textbox', { name: 'Note title', exact: true }).count(), 0);
    }
    assert.equal(await editing.evaluate(() => engine.observe('self/gym').getSnapshot().stored
      .find((row) => row.id === 'note000007').f.body[0]), '');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
