import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from './composerFixture.js';

import { LABELS, ROADMAP_SHEET, ROADMAP_VERBS, roadmapMatches, roadmapsHeading } from '../../../../src/products/roadmap/board/copy.js';

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
  if (options.keyboardHeight) {
    const visible = Object.assign(new EventTarget(), { offsetTop: 0, offsetLeft: 0, width: window.innerWidth, height: options.keyboardHeight });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visible });
  }
  const current = options.current ?? { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' };
  const listTrees = () => options.pending ? new Promise((resolve) => { window.resolveTrees = resolve; }) : options.fail ? Promise.reject(new Error('offline')) : Promise.resolve(options.rows ?? [
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
        onActivity: options.activity ? () => record('activity') : null,
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
          if (id === '\0roadmap-sheet-beacon') return beacon;
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
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/roadmap-sheet-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate(([options, theme]) => { document.documentElement.dataset.theme = theme; window.mount(options); }, [options, theme]);
    await page.locator('#title').click();
    await page.getByRole('dialog', { name: 'Roadmap', exact: true }).waitFor();
  });
  return page;
}

for (const width of [320, 390]) {
  for (const theme of ['light', 'dark']) {
    test(`Chromium: roadmap sheet ${width} ${theme} shows current first, compact counts and drawn tiles`, async () => {
      const page = await open({}, width, theme);
      try {
        await withBrowserErrors(page, async () => {
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
        });
      } finally { await page.close(); }
    });
  }
}

test('Chromium: sheet traps Tab and Escape, scrim and close return focus to the title', async () => {
  const page = await open();
  try {
    await withBrowserErrors(page, async () => {
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
    });
  } finally { await page.close(); }
});

test('Chromium: a failed list keeps current, null tiles disappear, and large progress stays exact', async () => {
  const page = await open({ fail: true, noAsk: true,
    current: { id: 'coast', title: 'Coastal navigation handbook', done: 3200, upNext: 30, locked: 1770, total: 5000, dominantKind: 'olive' } }, 320);
  try {
    await withBrowserErrors(page, async () => {
      assert.deepEqual(await page.locator('.st-roadmap-sheet-tree-name').allTextContents(), ['Coastal navigation handbook']);
      assert.deepEqual(await page.locator('.st-roadmap-sheet-verbs button').allTextContents(), ['Share', 'Export', 'Settings']);
      assert.equal(await page.locator('.st-roadmap-sheet-progress').textContent(), '3,200 done · 30 up next · 1,770 locked');
      const widths = await page.locator('.st-roadmap-sheet-verbs button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
      assert.equal(Math.max(...widths) - Math.min(...widths) < 1, true);
    });
  } finally { await page.close(); }
});

test('Chromium: every tile and navigation act runs after dismissal with bounded events', async () => {
  const page = await open();
  try {
    await withBrowserErrors(page, async () => {
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
    });
  } finally { await page.close(); }
});

test('Chromium: choosing the current roadmap only dismisses', async () => {
  const page = await open();
  try {
    await withBrowserErrors(page, async () => {
      await page.locator('[aria-current="true"]').click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => ({ actions: window.actions ?? [], events: window.events ?? [], focused: document.activeElement.id })), { actions: [], events: [], focused: 'title' });
    });
  } finally { await page.close(); }
});


test('Chromium: current roadmap renders while the registry is pending and stays authoritative', async () => {
  const page = await open({ pending: true });
  try {
    await withBrowserErrors(page, async () => {
      await page.waitForFunction(() => typeof window.resolveTrees === 'function');
      assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').allTextContents(), ['Learn to sail3/8']);
      await page.evaluate(() => window.resolveTrees([
        { id: 'spanish', title: 'Spanish basics', done: 12, total: 40, dominantKind: 'sky' },
        { id: 'sail', title: 'Stale title', done: 0, total: 8, dominantKind: 'sky' },
      ]));
      await page.locator('.st-roadmap-sheet-tree').nth(1).waitFor();
      assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').allTextContents(), ['Learn to sail3/8', 'Spanish basics12/40']);
    });
  } finally { await page.close(); }
});

for (const stateCounts of [{}, { upNext: 30 }, { locked: 1770 }]) {
  test(`Chromium: sheet progress stays truthful when counts are missing ${JSON.stringify(stateCounts)}`, async () => {
    const page = await open({ current: {
      id: 'coast', title: 'Coastal navigation handbook', done: 3200, total: 5000, ...stateCounts,
    } });
    try {
      await withBrowserErrors(page, async () => {
        assert.equal(await page.locator('.st-roadmap-sheet-progress').textContent(), '3,200 of 5,000 steps done');
      });
    } finally { await page.close(); }
  });
}

test('Chromium: exact progress includes zero counts from 1,000 and stays absent below the abbreviation threshold', async () => {
  const page = await open({ current: { id: 'coast', title: 'Coastal navigation handbook', done: 1000, total: 1000, upNext: 0, locked: 0 } });
  try {
    await withBrowserErrors(page, async () => {
      assert.equal(await page.locator('.st-roadmap-sheet-progress').textContent(), '1,000 done · 0 up next · 0 locked');
      await page.evaluate(() => window.mount({ current: { id: 'coast', title: 'Coastal navigation handbook', done: 999, total: 999, upNext: 0, locked: 0 } }));
      await page.locator('#title').click();
      await page.getByRole('dialog', { name: 'Roadmap', exact: true }).waitFor();
      assert.deepEqual(await page.locator('.st-roadmap-sheet-progress').allTextContents(), []);
    });
  } finally { await page.close(); }
});

const searchableRows = [
  { id: 'coast', title: 'Coastal navigation handbook', done: 3200, total: 5000, dominantKind: 'olive' },
  { id: 'code', title: 'Learn to code', done: 4, total: 20, dominantKind: 'olive' },
  ...Array.from({ length: 6 }, (_, index) => ({ id: `roadmap-${index}`, title: `Roadmap ${index}`, description: 'co', total: 8 })),
];

for (const width of [320, 390]) {
  test(`Chromium: sheet ${width} searches only above eight roadmaps and pins 44px controls`, async () => {
    const page = await open({ rows: searchableRows.slice(0, 7), activity: true }, width);
    try {
      await withBrowserErrors(page, async () => {
        await page.locator('.st-roadmap-sheet-tree').nth(7).waitFor();
        assert.equal(await page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap }).count(), 0);
        assert.equal(await page.locator('.st-roadmap-sheet-label').textContent(), ROADMAP_SHEET.yourRoadmaps);
        assert.equal(await page.getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).textContent(), ROADMAP_SHEET.newRoadmap);
        await page.getByRole('button', { name: LABELS.close, exact: true }).click();
        await page.evaluate((rows) => window.mount({ rows, activity: true }), searchableRows);
        await page.locator('#title').click();
        await page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap }).waitFor();
        assert.equal(await page.locator('.st-roadmap-sheet-label').textContent(), roadmapsHeading({ count: 9 }));
        assert.deepEqual(await page.locator('.st-roadmap-sheet-search-bar').evaluate((bar) => ({
          heights: [...bar.children].map((child) => child.getBoundingClientRect().height),
          fits: bar.scrollWidth <= bar.clientWidth,
        })), { heights: [44, 44], fits: true });
        assert.equal(await page.locator('.st-roadmap-sheet-content').getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).count(), 0);
      });
    } finally { await page.close(); }
  });
}

test('Chromium: roadmap search hides context, marks title matches, and clears before Escape dismisses', async () => {
  const page = await open({ rows: searchableRows, activity: true });
  try {
    await withBrowserErrors(page, async () => {
      const field = page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap });
      await field.fill('CO');
      assert.equal(await page.locator('.st-roadmap-sheet-label').textContent(), roadmapMatches({ shown: 2, total: 9 }));
      assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').evaluateAll((rows) => rows.map((row) => ({
        name: row.getAttribute('aria-label'), match: row.querySelector('mark').textContent,
      }))), [{ name: 'Coastal navigation handbook', match: 'Co' }, { name: 'Learn to code', match: 'co' }]);
      assert.equal(await page.locator('.st-roadmap-sheet-name, .st-roadmap-sheet-verbs').count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).count(), 1);
      await field.fill('sail');
      assert.deepEqual(await page.locator('.st-roadmap-sheet-tree').evaluateAll((rows) => rows.map((row) => ({
        name: row.getAttribute('aria-label'), current: row.getAttribute('aria-current'), checked: Boolean(row.querySelector('.st-roadmap-sheet-check svg')),
      }))), [{ name: 'Learn to sail', current: 'true', checked: true }]);
      await field.fill('no result');
      assert.equal(await page.locator('.st-roadmap-sheet-label').textContent(), roadmapMatches({ shown: 0, total: 9 }));
      assert.equal(await page.locator('.st-roadmap-sheet-tree').count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).count(), 1);
      await page.getByRole('button', { name: LABELS.clearSearch, exact: true }).click();
      assert.equal(await field.inputValue(), '');
      assert.equal(await field.evaluate((input) => input === document.activeElement), true);
      await field.fill('co');
      await page.keyboard.press('Escape');
      assert.equal(await field.inputValue(), '');
      assert.equal(await page.getByRole('dialog').count(), 1);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#title').evaluate((button) => button === document.activeElement), true);
      assert.deepEqual(await page.evaluate(() => window.events), [
        { name: 'roadmap_sheet', props: { step: 'search' } },
        { name: 'roadmap_sheet', props: { step: 'close', via: 'escape' } },
      ]);
      await page.locator('#title').click();
      await field.fill('co');
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ props }) => props.step === 'search')), [
        { name: 'roadmap_sheet', props: { step: 'search' } }, { name: 'roadmap_sheet', props: { step: 'search' } },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: Activity and the pinned new button dismiss before acting with bounded events', async () => {
  const page = await open({ rows: searchableRows, activity: true });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap }).waitFor();
      const activity = page.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true });
      assert.deepEqual([await activity.locator('.st-roadmap-activity-icon').count(), await activity.locator('svg').count()], [1, 1]);
      await activity.click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.locator('#title').click();
      await page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap }).fill('co');
      await page.getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.actions), [
        { name: 'activity', closed: true, focused: 'title' }, { name: 'new', closed: true, focused: 'title' },
      ]);
      assert.deepEqual(await page.evaluate(() => window.events), [
        { name: 'roadmap_verb', props: { verb: 'activity', door: 'sheet', view: 'graph', band: 'phone' } },
        { name: 'roadmap_sheet', props: { step: 'search' } },
        { name: 'roadmap_sheet', props: { step: 'new', door: 'search' } },
      ]);
      await page.evaluate(() => window.mount());
      await page.locator('#title').click();
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).count(), 0);
    });
  } finally { await page.close(); }
});


test('Chromium: the search footer stays above the keyboard using the composer viewport', async () => {
  const page = await open({ rows: searchableRows, keyboardHeight: 592 });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap }).fill('co');
      assert.deepEqual(await page.locator('.st-roadmap-sheet-search-bar').evaluate((bar) => ({
        height: bar.getBoundingClientRect().height,
        bottom: bar.getBoundingClientRect().bottom,
        dialogTop: bar.closest('[role="dialog"]').getBoundingClientRect().top,
      })), { height: 68, bottom: 592, dialogTop: 60 });
    });
  } finally { await page.close(); }
});
