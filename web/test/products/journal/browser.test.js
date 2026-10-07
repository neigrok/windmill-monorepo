import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

let server, browser, origin;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { BrowserSyncEngine } from '/src/platform/sync/engine.js';
  import { registry } from '/src/platform/sync/schema.js';
  import { syncSession } from '/src/platform/sync/session.js';
  import { usePages } from '/src/products/journal/usePages.js';
  import { localDay } from '/src/products/journal/localDay.js';
  export async function open(name) {
    window.engine = await BrowserSyncEngine.open({ name, registry,
      transport: { request() { throw new Error('offline'); }, openLive() { throw new Error('offline'); } },
      telemetry: { failure() {}, event() {} } });
    engine.setOnline(false);
    await engine.start();
    await engine.write(null, (device) => {
      const replica = device.activeReplica;
      replica.meta.state = 'bound'; replica.meta.account = 'A'; replica.meta.serverEpoch = 'ep-1';
      replica.cursorOf('self/journal').booted = true;
      if (!replica.confirmedRow('self/journal', 'page', localDay())) replica.putConfirmed('self/journal', {
        t: 'page', id: localDay(), seq: 1, rc: 1, ru: 1,
        f: { mood: [0, '1:0:srv'], energy: [null, '1:0:srv'], source: ['typed', '1:0:srv'],
          documentStamp: [{ ms: 1, counter: 0, actor: 'srv' }, '1:0:srv'] },
        x: { body: { text: 'account text', rev: 1, base: null } },
      });
    }, ['self/journal']);
    syncSession.engine = engine;
    syncSession.publish({ engine, ready: true, signedIn: true, online: false });
    const transact = engine.store.transact.bind(engine.store);
    engine.store.transact = (body, options) => transact((device) => {
      const result = body(device);
      if (window.abortJournalSave && result?.value?.writing) {
        window.abortJournalSave = false;
        throw new DOMException('journal test abort after decision', 'AbortError');
      }
      return result;
    }, options);
    function Editor() {
      const page = usePages();
      return React.createElement('main', { 'data-save-tick': page.saveTick, 'data-save-state': page.saveState, 'data-day': page.today },
        React.createElement('textarea', { 'aria-label': 'Body', value: page.body, onChange: (event) => page.setBody(event.target.value) }),
        React.createElement('button', { onClick: () => page.setMood(4) }, 'Mood'),
        React.createElement('button', { onClick: () => page.setEnergy(7) }, 'Energy'),
        React.createElement('output', { 'aria-label': 'Scores' }, JSON.stringify([page.mood, page.energy])),
        React.createElement('output', { 'aria-label': 'History' }, JSON.stringify(page.history)));
    }
    createRoot(document.getElementById('editor')).render(React.createElement(Editor));
  }
`;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-journal-test`, plugins: [{
    name: 'journal-hook-test',
    resolveId(id) { if (id === '/journal-hook-fixture.js') return '\0journal-hook-fixture'; },
    load(id) { if (id === '\0journal-hook-fixture') return fixture; },
    configureServer(server) {
      server.middlewares.use('/journal-hook-test', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Journal hook test</title><div id="editor"></div>');
      });
    },
  }], optimizeDeps: { include: ['react', 'react-dom/client', '@noble/hashes/sha256', '@noble/hashes/utils'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

async function open(context, name, now = null) {
  const page = await context.newPage();
  if (now) await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/journal-hook-test`);
  await page.evaluate(async (name) => { await (await import('/journal-hook-fixture.js')).open(name); }, name);
  await page.getByRole('textbox', { name: 'Body' }).waitFor();
  return page;
}
async function reopen(page, name) {
  await page.reload();
  await page.evaluate(async (name) => { await (await import('/journal-hook-fixture.js')).open(name); }, name);
  await page.getByRole('textbox', { name: 'Body' }).waitFor();
}
async function body(page, expected) {
  await page.waitForFunction((expected) => document.querySelector('textarea').value === expected, expected);
}

test('Chromium: settled journal saves use remote body updates for later mood and energy edits in two tabs', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const first = await open(context, 'journal-two-tabs');
    const second = await open(context, 'journal-two-tabs');
    await first.getByRole('textbox', { name: 'Body' }).fill('tab one original');
    await first.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    await body(second, 'tab one original');
    await second.getByRole('textbox', { name: 'Body' }).fill('tab two newer prose');
    await body(first, 'tab two newer prose');
    await first.getByRole('button', { name: 'Mood', exact: true }).click();
    await first.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 2);
    await body(second, 'tab two newer prose');
    assert.equal(await first.getByRole('textbox', { name: 'Body' }).inputValue(), 'tab two newer prose');
    await second.getByRole('textbox', { name: 'Body' }).fill('tab two newest prose');
    await body(first, 'tab two newest prose');
    await first.getByRole('button', { name: 'Energy', exact: true }).click();
    await first.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 3);
    await body(second, 'tab two newest prose');
    await second.waitForFunction(() => document.querySelector('output').textContent === '[4,7]');
    assert.deepEqual(await first.evaluate(() => {
      const args = engine.device.activeReplica.entries('self/journal').at(-1).intent.cmd.args;
      return { body: args.body, mood: args.mood, energy: args.energy };
    }), { body: 'tab two newest prose', mood: 4, energy: 7 });
  } finally { await context.close(); }
});

test('Chromium: an oversized draft survives offline reload and a correction replaces it', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'journal-oversized-draft');
    const draft = 'é'.repeat(65537);
    await page.getByRole('textbox', { name: 'Body' }).fill(draft);
    await page.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    assert.equal(await page.evaluate(() => engine.device.activeReplica.entries('self/journal').length), 0);
    await reopen(page, 'journal-oversized-draft');
    await body(page, draft);
    await page.getByRole('textbox', { name: 'Body' }).fill('corrected writing');
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__'] ?? null), null);
    await reopen(page, 'journal-oversized-draft');
    await body(page, 'corrected writing');
  } finally { await context.close(); }
});

test('Chromium: a transaction abort after the save decision keeps the latest editor input for retry', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const page = await open(context, 'journal-save-abort');
    const before = await page.evaluate(() => ({ rows: engine.device.activeReplica.deviceRows('journal'), entries: engine.device.activeReplica.entries('self/journal') }));
    await page.evaluate(() => { window.abortJournalSave = true; });
    await page.getByRole('textbox', { name: 'Body' }).fill('latest words after an aborted transaction');
    await page.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    assert.equal(await page.getByRole('textbox', { name: 'Body' }).inputValue(), 'latest words after an aborted transaction');
    assert.deepEqual(await page.evaluate(() => ({ rows: engine.device.activeReplica.deviceRows('journal'), entries: engine.device.activeReplica.entries('self/journal') })), before);
    await page.getByRole('button', { name: 'Mood', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    await reopen(page, 'journal-save-abort');
    await body(page, 'latest words after an aborted transaction');
    assert.equal(await page.getByRole('status', { name: 'Scores' }).textContent(), '[4,null]');
  } finally { await context.close(); }
});

test('Chromium: midnight carries unsaved words once into today with explicit zero and null answers', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const page = await open(context, 'journal-midnight-draft', '2026-10-01T23:59:00Z');
    await page.evaluate(async () => {
      await engine.write(null, (device) => device.activeReplica.putConfirmed('self/journal', {
        t: 'page', id: '2026-10-02', seq: 2, rc: 1, ru: 1,
        f: { mood: [7, '2:0:srv'], energy: [8, '2:0:srv'], source: ['typed', '2:0:srv'],
          documentStamp: [{ ms: 2, counter: 0, actor: 'srv' }, '2:0:srv'] },
        x: { body: { text: 'next day account prose', rev: 1, base: null } },
      }), ['self/journal']);
      window.abortJournalSave = true;
    });
    await page.getByRole('textbox', { name: 'Body' }).fill('late unsaved writing');
    await page.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    await page.clock.setFixedTime(new Date('2026-10-02T00:01:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    const expected = 'next day account prose\n\nlate unsaved writing';
    await body(page, expected);
    assert.deepEqual(await page.evaluate(() => {
      const args = engine.device.activeReplica.entries('self/journal').at(-1).intent.cmd.args;
      return { day: args.day, body: args.body, mood: args.mood, energy: args.energy };
    }), { day: '2026-10-02', body: expected, mood: 0, energy: null });
    await reopen(page, 'journal-midnight-draft');
    await body(page, expected);
    assert.equal((await page.getByRole('textbox', { name: 'Body' }).inputValue()).split('late unsaved writing').length - 1, 1);
  } finally { await context.close(); }
});

test('Chromium: a failed midnight draft replacement retains the prior durable draft until correction', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const page = await open(context, 'journal-midnight-preserved', '2026-10-01T23:59:00Z');
    const draft = 'x'.repeat(131073);
    await page.getByRole('textbox', { name: 'Body' }).fill(draft);
    await page.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    const prior = await page.evaluate(() => engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__']);
    await page.evaluate(() => { window.abortJournalSave = true; });
    await page.clock.setFixedTime(new Date('2026-10-02T00:01:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => window.abortJournalSave === false && document.querySelector('main').dataset.saveState === 'unsaved');
    assert.deepEqual(await page.evaluate(() => engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__']), prior);
    await reopen(page, 'journal-midnight-preserved');
    await page.waitForFunction(() => engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__']?.day === '2026-10-02');
    await body(page, `account text\n\n${draft}`);
    await page.getByRole('textbox', { name: 'Body' }).fill('corrected after midnight');
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    assert.equal(await page.evaluate(() => engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__'] ?? null), null);
    await reopen(page, 'journal-midnight-preserved');
    await body(page, 'corrected after midnight');
  } finally { await context.close(); }
});

test('Chromium: rapid rollover corrections retire the prior draft once and keep the latest editor input', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const page = await open(context, 'journal-midnight-rapid-correction', '2026-10-01T23:59:00Z');
    await page.evaluate(async () => {
      await engine.write(null, (device) => {
        device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__'] = {
          day: '2026-10-01', document: { body: 'retained late writing', mood: 0, energy: null, source: 'typed' },
        };
      }, ['self/journal']);
      const commit = engine.commit.bind(engine);
      engine.commit = (...args) => {
        engine.commit = commit;
        return new Promise((resolve, reject) => { window.releaseJournalSave = () => commit(...args).then(resolve, reject); });
      };
    });
    await body(page, 'retained late writing');
    await page.clock.setFixedTime(new Date('2026-10-02T00:01:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => typeof window.releaseJournalSave === 'function');
    await page.getByRole('textbox', { name: 'Body' }).fill('newest rollover correction');
    await body(page, 'newest rollover correction');
    await page.evaluate(() => window.releaseJournalSave());
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 2);
    await body(page, 'newest rollover correction');
    assert.deepEqual(await page.evaluate(() => ({
      draft: engine.device.activeReplica.deviceRows('journal')['pendingClaim:__editorDraft__'] ?? null,
      bodies: engine.device.activeReplica.entries('self/journal').map((entry) => entry.intent.cmd.args.body),
      latest: Object.values(engine.device.activeReplica.deviceRows('journal')).filter((row) => row?.claimId).map((row) => row.latest.body),
    })), { draft: null, bodies: ['retained late writing'], latest: ['newest rollover correction'] });
    await reopen(page, 'journal-midnight-rapid-correction');
    await body(page, 'newest rollover correction');
  } finally { await context.close(); }
});

test('Chromium: a save completing after midnight cannot clear newer unsaved input', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const page = await open(context, 'journal-midnight-late-save', '2026-10-01T23:59:00Z');
    await page.evaluate(() => {
      const commit = engine.commit.bind(engine);
      engine.commit = async (...args) => {
        engine.commit = commit;
        const result = await commit(...args);
        return new Promise((resolve) => { window.releaseOldSaved = () => resolve(result); });
      };
    });
    await page.getByRole('textbox', { name: 'Body' }).fill('written before midnight');
    await page.waitForFunction(() => typeof window.releaseOldSaved === 'function');
    await page.clock.setFixedTime(new Date('2026-10-02T00:01:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('textbox', { name: 'Body' }).fill('newer words after midnight');
    await body(page, 'newer words after midnight');
    await page.evaluate(() => window.releaseOldSaved());
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 2);
    await body(page, 'newer words after midnight');
    assert.deepEqual(await page.evaluate(() => engine.device.activeReplica.entries('self/journal').map((entry) => ({
      day: entry.intent.cmd.args.day, body: entry.intent.cmd.args.body,
    }))), [
      { day: '2026-10-01', body: 'written before midnight' },
      { day: '2026-10-02', body: 'newer words after midnight' },
    ]);
    await reopen(page, 'journal-midnight-late-save');
    await body(page, 'newer words after midnight');
  } finally { await context.close(); }
});
