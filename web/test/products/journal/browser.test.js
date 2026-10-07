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
    function Editor() {
      const page = usePages();
      return React.createElement('main', { 'data-save-tick': page.saveTick },
        React.createElement('textarea', { 'aria-label': 'Body', value: page.body, onChange: (event) => page.setBody(event.target.value) }),
        React.createElement('button', { onClick: () => page.setMood(4) }, 'Mood'),
        React.createElement('button', { onClick: () => page.setEnergy(7) }, 'Energy'),
        React.createElement('output', { 'aria-label': 'Scores' }, JSON.stringify([page.mood, page.energy])));
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

async function open(context, name) {
  const page = await context.newPage();
  await page.goto(`${origin}/journal-hook-test`);
  await page.evaluate(async (name) => { await (await import('/journal-hook-fixture.js')).open(name); }, name);
  await page.getByRole('textbox', { name: 'Body' }).waitFor();
  return page;
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
