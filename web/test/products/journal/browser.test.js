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
  let root;
  export async function open(name, { migrate = false, legacy = null } = {}) {
    const options = { name, registry,
      transport: { request() { throw new Error('offline'); }, openLive() { throw new Error('offline'); } },
      telemetry: { failure() {}, event() {} } };
    if (migrate) {
      if (legacy) localStorage.setItem('wm.journal.v2.pages.anon', JSON.stringify(legacy));
      window.engine = await syncSession.open({ ...options, prepare: async (opened) => {
        opened.setOnline(false);
        const { migratePages } = await import('/src/products/journal/migrate.js');
        await migratePages(opened);
      } });
    } else {
      window.engine = await BrowserSyncEngine.open(options);
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
    }
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
    root = createRoot(document.getElementById('editor'));
    root.render(React.createElement(Editor));
  }
  export async function showCanvas() {
    const { Canvas } = await import('/src/products/journal/Canvas.jsx');
    root.render(React.createElement(Canvas));
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
  }], optimizeDeps: { include: ['react', 'react-dom/client'] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { await ready; await browser?.close(); await server?.close(); });

async function open(context, name, now = null, options = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  if (now) await page.clock.setFixedTime(new Date(now));
  await page.goto(`${origin}/journal-hook-test`);
  await page.evaluate(async ([name, options]) => { await (await import('/journal-hook-fixture.js')).open(name, options); }, [name, options]);
  await page.getByRole('textbox', { name: 'Body' }).waitFor();
  return page;
}
async function reopen(page, name, options = {}) {
  await page.reload();
  await page.evaluate(async ([name, options]) => { await (await import('/journal-hook-fixture.js')).open(name, options); }, [name, options]);
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

test('Chromium: an untouched recovered draft follows a peer correction before a scale edit', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const first = await open(context, 'w6_journal-recovered-peer-correction');
    const draft = 'X'.repeat(131073);
    await first.getByRole('textbox', { name: 'Body' }).fill(draft);
    await first.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    const second = await open(context, 'w6_journal-recovered-peer-correction');
    await body(second, draft);
    const corrected = 'corrected words in tab one';
    await first.getByRole('textbox', { name: 'Body' }).fill(corrected);
    await second.waitForFunction((corrected) => engine.device.activeReplica.entries('self/journal')
      .at(-1)?.intent.cmd.args.body === corrected, corrected);
    await second.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await second.getByRole('textbox', { name: 'Body' }).inputValue()).length, corrected.length);
    await body(second, corrected);
    await second.getByRole('button', { name: 'Mood', exact: true }).click();
    await second.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    assert.deepEqual(await second.evaluate(() => {
      const args = engine.device.activeReplica.entries('self/journal').at(-1).intent.cmd.args;
      return { body: args.body, mood: args.mood, energy: args.energy };
    }), { body: corrected, mood: 4, energy: null });
    assert.equal(await second.evaluate(async (draft) => {
      const { EditorDraft } = await import('/src/products/journal/domain/writing.js');
      return Object.entries(engine.device.activeReplica.deviceRows('journal'))
        .some(([key, row]) => key.startsWith(EditorDraft.recoveryPrefix) && row.document.body === draft);
    }, draft), true);
    await reopen(second, 'w6_journal-recovered-peer-correction');
    await body(second, corrected);
  } finally { await context.close(); }
});

test('Chromium: recovered storage updates refresh untouched input while locally typed words survive a peer correction', async () => {
  await ready;
  const context = await browser.newContext();
  try {
    const name = 'w6_journal-recovered-peer-update';
    const first = await open(context, name);
    const initial = 'A'.repeat(131073);
    await first.getByRole('textbox', { name: 'Body' }).fill(initial);
    await first.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    const second = await open(context, name);
    await body(second, initial);
    const updated = 'B'.repeat(131074);
    await first.getByRole('textbox', { name: 'Body' }).fill(updated);
    await second.waitForFunction((updated) => engine.device.activeReplica.deviceRows('journal')
      ['pendingClaim:__editorDraft__']?.document.body === updated, updated);
    await second.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal((await second.getByRole('textbox', { name: 'Body' }).inputValue()).length, updated.length);
    await body(second, updated);
    const local = 'C'.repeat(131075);
    await second.getByRole('textbox', { name: 'Body' }).fill(local);
    await second.waitForFunction((local) => engine.device.activeReplica.deviceRows('journal')
      ['pendingClaim:__editorDraft__']?.document.body === local, local);
    await first.getByRole('textbox', { name: 'Body' }).fill('peer correction after local typing');
    await second.waitForFunction(() => engine.device.activeReplica.entries('self/journal')
      .at(-1)?.intent.cmd.args.body === 'peer correction after local typing');
    await body(second, local);
    assert.equal(await second.evaluate(async (local) => {
      const { EditorDraft } = await import('/src/products/journal/domain/writing.js');
      return Object.entries(engine.device.activeReplica.deviceRows('journal'))
        .some(([key, row]) => key.startsWith(EditorDraft.recoveryPrefix) && row.document.body === local);
    }, local), true);
    await second.getByRole('button', { name: 'Energy', exact: true }).click();
    await second.waitForFunction(() => engine.device.activeReplica.deviceRows('journal')
      ['pendingClaim:__editorDraft__']?.document.energy === 7);
    await reopen(second, name);
    await body(second, local);
    assert.equal(await second.getByRole('status', { name: 'Scores' }).textContent(), '[0,7]');
  } finally { await context.close(); }
});

test('Chromium: Canvas exposes the complete recovered draft beside the corrected page after peer correction and reload', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const name = 'w6_journal-recovery-canvas';
    const first = await open(context, name, '2026-10-01T12:00:00Z');
    const original = 'preserved writing '.repeat(8000);
    await first.getByRole('textbox', { name: 'Body' }).fill(original);
    await first.waitForFunction(() => document.querySelector('main').dataset.saveState === 'unsaved');
    const second = await open(context, name, '2026-10-01T12:00:00Z');
    await body(second, original);
    await first.getByRole('textbox', { name: 'Body' }).fill('corrected page remains today');
    await body(second, 'corrected page remains today');
    for (const reload of [false, true]) {
      if (reload) await reopen(second, name);
      await second.evaluate(async () => (await import('/journal-hook-fixture.js')).showCanvas());
      const today = second.getByRole('textbox', { name: 'Write today', exact: true });
      await today.waitFor();
      assert.equal(await today.inputValue(), 'corrected page remains today');
      await second.getByText('Recovered drafts (1)', { exact: true }).click();
      await second.getByText('2026-10-01 · draft 1', { exact: true }).click();
      const recovered = second.getByRole('textbox', { name: 'Recovered draft 1 from 2026-10-01', exact: true });
      await recovered.waitFor({ state: 'visible' });
      assert.equal((await recovered.inputValue()).length, original.length);
      assert.equal(await recovered.inputValue(), original);
      assert.equal(await recovered.evaluate((field) => field.readOnly), true);
      assert.equal(await second.locator('.journal-recoveries details > p').textContent(), 'Mood: 0 · Energy: not answered · typed');
      assert.equal(await today.inputValue(), 'corrected page remains today');
    }
  } finally { await context.close(); }
});

test('Chromium: first offline open migrates oversized legacy writing for correction and durable reload', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const name = 'w6_journal-legacy-offline-migration';
    const original = 'legacy writing '.repeat(10000);
    const legacy = Object.fromEntries([
      ['2026-10-01', original], ['2026-09-30', 'valid older page'],
    ].map(([day, body]) => [day, { page: { day, body, mood: 0, energy: null, source: 'spoken', stamp: '1:0:legacy' }, needsPush: true, read: false }]));
    const page = await open(context, name, '2026-10-01T12:00:00Z', { migrate: true, legacy });
    await body(page, original);
    assert.deepEqual(await page.evaluate(async () => {
      const { syncSession } = await import('/src/platform/sync/session.js');
      return { ready: syncSession.snapshot.ready, error: syncSession.snapshot.error, closed: engine.closed,
        legacy: localStorage.getItem('wm.journal.v2.pages.anon'),
        commands: engine.device.activeReplica.entries('self/journal').map((entry) => entry.intent.cmd.args.body) };
    }), { ready: true, error: false, closed: false, legacy: null, commands: ['valid older page'] });
    assert.equal(await page.getByRole('status', { name: 'Scores' }).textContent(), '[0,null]');
    await page.getByRole('textbox', { name: 'Body' }).fill('corrected legacy writing');
    await page.waitForFunction(() => Number(document.querySelector('main').dataset.saveTick) === 1);
    await reopen(page, name, { migrate: true });
    await body(page, 'corrected legacy writing');
    assert.deepEqual(await page.evaluate(() => engine.device.activeReplica.entries('self/journal').map((entry) => ({
      day: entry.intent.cmd.args.day, body: entry.intent.cmd.args.body,
    }))), [
      { day: '2026-09-30', body: 'valid older page' },
      { day: '2026-10-01', body: 'corrected legacy writing' },
    ]);
    assert.equal(await page.evaluate(async (original) => {
      const { EditorDraft } = await import('/src/products/journal/domain/writing.js');
      return Object.entries(engine.device.activeReplica.deviceRows('journal'))
        .some(([key, row]) => key.startsWith(EditorDraft.recoveryPrefix) && row.document.body === original);
    }, original), true);
  } finally { await context.close(); }
});

test('Chromium: notice cleanup failure after a durable save does not carry the page across midnight', async () => {
  await ready;
  const context = await browser.newContext({ timezoneId: 'UTC' });
  try {
    const page = await open(context, 'w6_journal-notice-cleanup-midnight', '2026-10-01T23:59:00Z');
    await page.evaluate(async () => {
      const scope = 'self/journal';
      await engine.write(null, (device) => device.activeReplica.notices.push({
        id: 'notice-cleanup-midnight', scope, code: 'too-large', dismissed: false,
        content: { cmd: { name: 'journal.savePage', args: {
          day: '2026-10-01', body: 'refused prior text', mood: 0, energy: null, source: 'typed',
          stamp: { ms: 2, counter: 0, actor: 'old' },
        } } },
      }), [scope]);
      const transact = engine.store.transact.bind(engine.store);
      engine.store.transact = (change, options) => transact((device) => {
        const durable = device.activeReplica.entries(scope).some((entry) => entry.intent.cmd?.args.body === 'saved before midnight');
        const dismissed = device.activeReplica.notices.find((notice) => notice.id === 'notice-cleanup-midnight')?.dismissed;
        const result = change(device);
        if (options?.readonly !== true && durable && !dismissed && !window.noticeCleanupAborted
          && device.activeReplica.notices.find((notice) => notice.id === 'notice-cleanup-midnight')?.dismissed) {
          window.noticeCleanupAborted = true;
          throw new DOMException('journal test abort during notice cleanup', 'AbortError');
        }
        return result;
      }, options);
    });
    await page.getByRole('textbox', { name: 'Body' }).fill('saved before midnight');
    await page.waitForFunction(() => window.noticeCleanupAborted || Number(document.querySelector('main').dataset.saveTick) > 0);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(() => ({
      tick: Number(document.querySelector('main').dataset.saveTick),
      commands: engine.device.activeReplica.entries('self/journal').map((entry) => ({
        day: entry.intent.cmd.args.day, body: entry.intent.cmd.args.body,
      })),
    }));
    await page.clock.setFixedTime(new Date('2026-10-02T00:01:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('main').dataset.day === '2026-10-02');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(before.tick, 1);
    assert.equal(await page.getByRole('textbox', { name: 'Body' }).inputValue(), '');
    assert.deepEqual(await page.evaluate(() => engine.device.activeReplica.entries('self/journal').map((entry) => ({
      day: entry.intent.cmd.args.day, body: entry.intent.cmd.args.body,
    }))), before.commands);
    assert.deepEqual(before.commands, [{ day: '2026-10-01', body: 'saved before midnight' }]);
    const history = JSON.parse(await page.getByRole('status', { name: 'History' }).textContent());
    assert.deepEqual(history.map((entry) => ({ day: entry.day, body: entry.body })), before.commands);
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
