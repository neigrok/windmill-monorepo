import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { RoadmapSheet } from '/src/products/roadmap/board/RoadmapSheet.jsx';
const root = createRoot(document.getElementById('root'));
window.mount = (options = {}) => {
  const current = options.current ?? { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' };
  const listTrees = () => options.pending ? new Promise((resolve) => { window.resolveTrees = resolve; }) : options.fail ? Promise.reject(new Error('offline')) : Promise.resolve([
    { id: 'coast', title: 'Coastal navigation handbook', done: 3200, total: 5000, dominantKind: 'olive' },
    { id: 'sail', title: 'Stale title', done: 0, total: 8, dominantKind: 'sky' },
    { id: 'spanish', title: 'Spanish basics', done: 12, total: 40, dominantKind: 'sky' },
  ]);
  const record = (name) => { (window.actions ??= []).push({ name, closed: !document.querySelector('[role="dialog"]'), focused: document.activeElement.id }); };
  const sheet = { current, listTrees, onPickTree: (id) => record(id), onNewRoadmap: () => record('new'), onBrowse: () => record('browse') };
  function Room() {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
      React.createElement('button', { id: 'title', onClick: () => setOpen(true) }, current.title),
      open && React.createElement(RoadmapSheet, { sheet, view: 'tree', band: 'phone',
        onAskAI: options.noAsk ? null : () => record('askAI'), onShare: () => record('share'),
        onExport: () => record('export'), onSettings: () => record('settings'),
        onClose: () => { flushSync(() => setOpen(false)); document.getElementById('title').focus(); } }));
  }
  root.render(React.createElement(Room));
};
window.entryReady = true;
`;
let server, browser, origin;
let ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-roadmap-sheet-test`,
      plugins: [{ name: 'roadmap-sheet-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/roadmap-sheet-entry.js') return '\0roadmap-sheet-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0roadmap-sheet-beacon';
        },
        load(id) {
          if (id === '\0roadmap-sheet-entry') return entry;
          if (id === '\0roadmap-sheet-beacon') return 'export function track(name, props) { (window.events ??= []).push({ name, props }); }';
        },
        configureServer(vite) {
          vite.middlewares.use('/roadmap-sheet-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Sheet test</title><div id="root"></div><script type="module" src="/roadmap-sheet-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  await browser?.close();
  await server?.close();
});

async function open(options = {}, width = 390, theme = 'light') {
  await start();
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.goto(`${origin}/roadmap-sheet-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(([options, theme]) => { document.documentElement.dataset.theme = theme; window.mount(options); }, [options, theme]);
  await page.locator('#title').click();
  await page.getByRole('dialog', { name: 'Roadmap', exact: true }).waitFor();
  return page;
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`Chromium: roadmap sheet ${width} ${theme} shows current first, compact counts and drawn tiles`, async () => {
      const page = await open({}, width, theme);
      try {
        await page.locator('.st-roadmap-sheet-tree').nth(2).waitFor();
        assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').evaluateAll((rows) => rows.map((row) => ({
          title: row.querySelector('.st-roadmap-sheet-tree-name').textContent,
          count: row.querySelector('.st-roadmap-sheet-count').textContent,
          current: row.getAttribute('aria-current'),
          checked: Boolean(row.querySelector('.st-roadmap-sheet-check svg')),
        }))), [
          { title: 'Learn to sail', count: '3/8', current: 'true', checked: true },
          { title: 'Coastal navigation handbook', count: '3.2k/5k', current: null, checked: false },
          { title: 'Spanish basics', count: '12/40', current: null, checked: false },
        ]);
        assert.deepEqual(await page.locator('.st-roadmap-sheet-verbs button').allTextContents(), ['Ask AI', 'Share', 'Export', 'Settings']);
        assert.equal(await page.locator('.st-roadmap-sheet-progress, [type="search"]').count(), 0);
        assert.equal(await page.getByRole('dialog').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
      } finally { await page.close(); }
    });
  }
}

test('Chromium: sheet traps Tab and Escape, scrim and close return focus to the title', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Planted in public');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'title');
    await page.locator('#title').click();
    await page.locator('.st-board-sheet-scrim').click({ position: { x: 10, y: 10 } });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'title');
    await page.locator('#title').click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'title');
    assert.deepEqual(await page.evaluate(() => window.events), [
      { name: 'roadmap_sheet', props: { step: 'close', via: 'escape' } },
      { name: 'roadmap_sheet', props: { step: 'close', via: 'scrim' } },
      { name: 'roadmap_sheet', props: { step: 'close', via: 'close' } },
    ]);
  } finally { await page.close(); }
});

test('Chromium: a failed list keeps current, null tiles disappear, and large progress stays exact', async () => {
  const page = await open({ fail: true, noAsk: true,
    current: { id: 'coast', title: 'Coastal navigation handbook', done: 3200, total: 5000, dominantKind: 'olive' } }, 320);
  try {
    assert.deepEqual(await page.locator('.st-roadmap-sheet-tree-name').allTextContents(), ['Coastal navigation handbook']);
    assert.deepEqual(await page.locator('.st-roadmap-sheet-verbs button').allTextContents(), ['Share', 'Export', 'Settings']);
    assert.equal(await page.locator('.st-roadmap-sheet-progress').textContent(), '3,200 of 5,000 steps done');
    const widths = await page.locator('.st-roadmap-sheet-verbs button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
    assert.equal(Math.max(...widths) - Math.min(...widths) < 1, true);
  } finally { await page.close(); }
});

test('Chromium: every tile and navigation act runs after dismissal with bounded events', async () => {
  const page = await open();
  try {
    for (const label of ['Ask AI', 'Share', 'Export', 'Settings', 'New roadmap', 'Planted in public']) {
      await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.locator('#title').click();
    }
    await page.locator('.st-roadmap-sheet-tree').filter({ hasText: 'Spanish basics' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.actions), ['askAI', 'share', 'export', 'settings', 'new', 'browse', 'spanish'].map((name) => ({ name, closed: true, focused: 'title' })));
    assert.deepEqual(await page.evaluate(() => window.events), [
      ...['askAI', 'share', 'export', 'settings'].map((verb) => ({ name: 'roadmap_verb', props: { verb, door: 'sheet', view: 'graph', band: 'phone' } })),
      ...['new', 'browse', 'switch'].map((step) => ({ name: 'roadmap_sheet', props: { step } })),
    ]);
  } finally { await page.close(); }
});

test('Chromium: choosing the current roadmap only dismisses', async () => {
  const page = await open();
  try {
    await page.locator('[aria-current="true"]').click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => ({ actions: window.actions ?? [], events: window.events ?? [], focused: document.activeElement.id })), { actions: [], events: [], focused: 'title' });
  } finally { await page.close(); }
});


test('Chromium: current roadmap renders while the registry is pending and stays authoritative', async () => {
  const page = await open({ pending: true });
  try {
    await page.waitForFunction(() => typeof window.resolveTrees === 'function');
    assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').allTextContents(), ['Learn to sail3/8']);
    await page.evaluate(() => window.resolveTrees([
      { id: 'spanish', title: 'Spanish basics', done: 12, total: 40, dominantKind: 'sky' },
      { id: 'sail', title: 'Stale title', done: 0, total: 8, dominantKind: 'sky' },
    ]));
    await page.locator('.st-roadmap-sheet-tree').nth(1).waitFor();
    assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').allTextContents(), ['Learn to sail3/8', 'Spanish basics12/40']);
  } finally { await page.close(); }
});
