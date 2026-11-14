import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { TreeSwitcher } from '/src/products/roadmap/identity/TreeSwitcher.jsx';
window.mount = (rows) => createRoot(document.getElementById('fixture')).render(React.createElement(TreeSwitcher, {
  current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' },
  listTrees: async () => rows, onNew() {},
  onRename: async (...args) => {
    (window.renames ??= []).push(args);
    if (window.failRename) throw new Error('Private rename text');
  },
  onPreviewTitle: (...args) => { (window.previews ??= []).push(args); },
  onDelete: async (...args) => {
    (window.deletes ??= []).push(args);
    if (window.failDelete) throw new Error('Private delete text');
    if (window.deferDelete) await new Promise((resolve) => { window.finishDelete = resolve; });
  },
}));
window.entryReady = true;
`;
let server, browser, webkitBrowser, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-tree-switcher-test`,
      plugins: [{ name: 'tree-switcher-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/tree-switcher-entry.js') return '\0tree-switcher-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0tree-switcher-beacon';
          if (id.endsWith('/telemetry/sentry.js')) return '\0tree-switcher-sentry';
        },
        load(id) {
          if (id === '\0tree-switcher-entry') return entry;
          if (id === '\0tree-switcher-beacon') return beacon;
          if (id === '\0tree-switcher-sentry') return 'export function captureError(...args) { (window.failures ??= []).push(args); }';
        },
        configureServer(vite) {
          vite.middlewares.use('/tree-switcher-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="fixture" style="width:200px"></div><div id="blank" style="margin-top:300px;height:100px">Outside</div><script type="module" src="/tree-switcher-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0 } });
    await new Promise((resolve, reject) => {
      server.httpServer.once('error', reject);
      server.httpServer.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => { await browser?.close(); await webkitBrowser?.close(); await server?.close(); });

async function withSwitcher(rows, run, { engine = 'Chromium', width = 1440, touch = false } = {}) {
  await start();
  if (engine === 'WebKit') webkitBrowser ??= await webkit.launch({ headless: true });
  const page = await (engine === 'WebKit' ? webkitBrowser : browser).newPage({ viewport: { width, height: 900 }, hasTouch: touch, reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(20000);
  try {
    await withBrowserErrors(page, async () => {
      await page.goto(`${origin}/tree-switcher-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate((list) => window.mount(list), rows);
      await run(page);
    });
  } finally { await page.close(); }
}

async function openMenu(page) {
  await page.locator('#fixture [aria-haspopup="menu"]').click();
  await page.getByRole('menu').waitFor();
}

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: tablet touch exposes 44px switcher actions before hover`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      const rename = page.getByRole('button', { name: 'Rename Learn to sail' });
      await rename.waitFor();
      assert.deepEqual(await rename.evaluate((button) => ({
        coarse: matchMedia('(pointer: coarse)').matches,
        opacity: getComputedStyle(button.parentElement).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      })), { coarse: true, opacity: '1', pointerEvents: 'auto', width: 44, height: 44 });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: keyboard focus reveals the switcher actions without hover`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem').first().waitFor();
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      await page.keyboard.press(engine === 'WebKit' ? 'Alt+Tab' : 'Tab');
      const rename = page.getByRole('button', { name: 'Rename Learn to sail' });
      await page.waitForFunction(() => getComputedStyle(document.activeElement.parentElement).opacity === '1');
      assert.deepEqual(await rename.evaluate((button) => ({
        focused: document.activeElement === button,
        opacity: getComputedStyle(button.parentElement).opacity,
        pointerEvents: getComputedStyle(button).pointerEvents,
        outline: getComputedStyle(button).outlineStyle,
      })), { focused: true, opacity: '1', pointerEvents: 'auto', outline: 'solid' });
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-keyboard-focus.png` });
    }, { engine, width: 744 });
  });

  test(`${engine}: tablet actions keep titles clear, hit their full targets, and respect row permissions`, async () => {
    const title = 'A very long roadmap title that must leave both row actions available';
    for (const width of [744, 834, 1023]) {
      await withSwitcher([
        { id: 'sail', title: 'Learn to sail', origin: 'server' },
        { id: 'long', title, origin: 'server' },
        { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
        { id: 'claimed', title: 'Claimed roadmap', origin: 'device', claimed: true },
        { id: 'readonly', title: 'Read only roadmap' },
      ], async (page) => {
        await page.locator('#fixture [aria-haspopup="menu"]').tap();
        await page.getByRole('button', { name: `Rename ${title}` }).waitFor();
        assert.deepEqual(await page.locator('.st-switcher-actions button').evaluateAll((buttons) => buttons.map((button) => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return {
            name: button.getAttribute('aria-label'), width, height,
            edges: [[2, height / 2], [width - 2, height / 2], [width / 2, 2], [width / 2, height - 2]]
              .every(([dx, dy]) => button.contains(document.elementFromPoint(x + dx, y + dy))),
          };
        })), ['Learn to sail', title, 'Device roadmap'].flatMap((name) => ['Rename', 'Delete'].map((action) => ({ name: `${action} ${name}`, width: 44, height: 44, edges: true }))));
        const longRow = page.getByRole('menuitem').filter({ hasText: title });
        assert.deepEqual(await longRow.evaluate((row) => {
          const name = row.querySelector('[title]');
          return { truncated: name.scrollWidth > name.clientWidth, clear: name.getBoundingClientRect().right < row.querySelector('button').getBoundingClientRect().left };
        }), { truncated: true, clear: true });
        if (process.env.WM_SWITCHER_SCREENSHOTS && width === 744) {
          await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-touch-light.png` });
          await page.evaluate(() => {
            document.documentElement.setAttribute('data-brand', 'roadmap');
            document.documentElement.setAttribute('data-theme', 'dark');
          });
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor === 'rgb(23, 23, 25)');
          await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-touch-dark.png` });
        }
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } })));
        await page.getByRole('button', { name: 'Rename Device roadmap' }).waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('button', { name: 'Delete Device roadmap' }).count(), 0);
        assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], hash: location.hash })), { renames: [], deletes: [], hash: '' });
      }, { engine, width, touch: true });
    }
  });

  test(`${engine}: rename and delete cancellation restore the row action before outer Escape closes`, async () => {
    await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
      const tab = engine === 'WebKit' ? 'Alt+Tab' : 'Tab';
      const trigger = page.locator('#fixture [aria-haspopup="menu"]');
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem').first().waitFor();
      await page.keyboard.press(tab);
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      const input = page.getByRole('textbox', { name: 'Tree name' });
      await input.waitFor();
      assert.deepEqual(await input.evaluate((field) => ({ focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd })), { focused: true, start: 0, end: 13 });
      await input.fill('Cancelled title');
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-rename.png` });
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'Rename Learn to sail' }).evaluate((button) => document.activeElement === button), true);
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      assert.equal(await page.getByRole('button', { name: 'Delete', exact: true }).evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.locator('.st-switcher-confirm-actions button').evaluateAll((buttons) => buttons.map((button) => ({ name: button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }))), [{ name: 'Delete', width: 84, height: 44 }, { name: 'Keep', width: 84, height: 44 }]);
      assert.equal(await page.getByRole('menuitem').first().textContent(), 'Delete Learn to sail? This can’t be undoneDeleteKeep');
      if (process.env.WM_SWITCHER_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_SWITCHER_SCREENSHOTS}/${engine.toLowerCase()}-delete-confirmation.png` });
      await page.keyboard.press(tab);
      await page.keyboard.press('Enter');
      const del = page.getByRole('button', { name: 'Delete Learn to sail' });
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Keep' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], hash: location.hash, events: window.events })), {
        renames: [], deletes: [], hash: '', events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }],
      });
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate((button) => document.activeElement === button), true);
    }, { engine, width: 834 });
  });

  test(`${engine}: touch rename saves through server and device callbacks without row navigation`, async () => {
    await withSwitcher([
      { id: 'sail', title: 'Learn to sail', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
    ], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
      const input = page.getByRole('textbox', { name: 'Tree name' });
      await input.fill('  Device plan  ');
      await input.press('Enter');
      const localRename = page.getByRole('button', { name: 'Rename Device plan' });
      assert.equal(await localRename.evaluate((button) => document.activeElement === button), true);
      await page.getByRole('button', { name: 'Rename Learn to sail' }).tap();
      await input.fill('Sailing plan');
      await page.getByRole('menuitem').first().locator(':scope > span').first().tap();
      await page.getByRole('button', { name: 'Rename Sailing plan' }).waitFor();
      await page.waitForTimeout(250);
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames, hash: location.hash, events: window.events })), {
        renames: [['device', 'Device plan', { local: true }], ['sail', 'Sailing plan', { local: false }]], hash: '',
        events: ['open', 'rename', 'rename'].map((step) => ({ name: 'roadmap_sheet', props: { step, door: 'switcher' } })),
      });
      assert.equal(await page.getByRole('menu').count(), 1);
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: delete keeps its existing callbacks and route while focus follows surviving rows`, async () => {
    await withSwitcher([
      { id: 'sail', title: 'Learn to sail', origin: 'server' },
      { id: 'server', title: 'Another roadmap', origin: 'server' },
      { id: 'device', title: 'Device roadmap', origin: 'device', claimed: false },
    ], async (page) => {
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      for (const [title, next] of [['Another roadmap', 'Device roadmap'], ['Device roadmap', 'Learn to sail']]) {
        await page.getByRole('button', { name: `Delete ${title}` }).tap();
        await page.getByRole('button', { name: 'Delete', exact: true }).tap();
        await page.getByRole('button', { name: `Delete ${title}` }).waitFor({ state: 'detached' });
        assert.equal(await page.getByRole('menuitem').filter({ hasText: next }).evaluate((row) => document.activeElement === row), true);
        assert.equal(await page.evaluate(() => location.hash), '');
      }
      await page.getByRole('button', { name: 'Delete Learn to sail' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#fixture [aria-haspopup="menu"]').evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({ deletes: window.deletes, hash: location.hash, events: window.events })), {
        deletes: [['server', { local: false }], ['device', { local: true }], ['sail', { local: false }]], hash: '#/app',
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          ...['account', 'device', 'account'].map((place) => ({ name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place } })),
        ],
      });
    }, { engine, width: 1023, touch: true });
  });

  test(`${engine}: fine pointer reveal and existing desktop and phone action sizes stay intact`, async () => {
    for (const width of [743, 744, 1024, 1440]) {
      await withSwitcher([{ id: 'sail', title: 'Learn to sail', origin: 'server' }], async (page) => {
        await openMenu(page);
        const actions = page.locator('.st-switcher-actions');
        await actions.waitFor();
        assert.equal(await actions.evaluate((element) => getComputedStyle(element).opacity), '0');
        await page.getByRole('menuitem').first().hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-switcher-actions')).opacity === '1');
        assert.deepEqual(await page.getByRole('button', { name: 'Rename Learn to sail' }).evaluate((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })), { width: width === 744 ? 44 : 22, height: width === 744 ? 44 : 22 });
        await page.locator('#blank').hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-switcher-actions')).opacity === '0');
      }, { engine, width });
    }
  });

  test(`${engine}: row click and double click retain navigation and rename without an action activating the row`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await openMenu(page);
      const row = page.getByRole('menuitem').filter({ hasText: 'Another roadmap' });
      await row.locator('[title]').dblclick();
      await page.getByRole('textbox', { name: 'Tree name' }).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.keyboard.press('Escape');
      await row.locator('[title]').click();
      await page.getByRole('button', { name: 'Delete Another roadmap' }).click();
      await page.waitForTimeout(250);
      assert.equal(await page.getByRole('button', { name: 'Keep' }).count(), 1);
      assert.equal(await page.evaluate(() => location.hash), '');
      await page.getByRole('button', { name: 'Keep' }).click();
      await row.locator('[title]').click();
      await page.waitForFunction(() => location.hash === '#/app/other');
      assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], events: window.events })), {
        renames: [], deletes: [], events: ['open', 'switch'].map((step) => ({ name: 'roadmap_sheet', props: { step, door: 'switcher' } })),
      });
    }, { engine, width: 834 });
  });

  test(`${engine}: failed mutations retain static failure operations and bounded events`, async () => {
    await withSwitcher([{ id: 'device', title: 'Device roadmap', origin: 'device', claimed: false }], async (page) => {
      await page.evaluate(() => { window.failRename = true; window.failDelete = true; });
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
      await page.getByRole('textbox', { name: 'Tree name' }).fill('Private draft');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Delete Device roadmap' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      const del = page.getByRole('button', { name: 'Delete Device roadmap' });
      await del.waitFor();
      assert.equal(await del.evaluate((button) => document.activeElement === button), true);
      assert.deepEqual(await page.evaluate(() => ({
        failures: window.failures.map(([kind, operation, stack, route, tags]) => ({ kind, operation, private: /Private/.test(stack), route, tags })),
        events: window.events, hash: location.hash,
      })), {
        failures: ['rename', 'delete'].map((action) => ({ kind: 'roadmap', operation: `roadmap-switcher-${action}`, private: false, route: '#/app', tags: undefined })),
        events: [
          { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
          { name: 'roadmap_sheet', props: { step: 'rename', door: 'switcher', outcome: 'failed' } },
          { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', outcome: 'failed', place: 'device' } },
        ], hash: '',
      });
    }, { engine, width: 744, touch: true });
  });

  test(`${engine}: a delayed delete does not take focus from a later action`, async () => {
    await withSwitcher([{ id: 'other', title: 'Another roadmap', origin: 'server' }], async (page) => {
      await page.evaluate(() => { window.deferDelete = true; });
      await page.locator('#fixture [aria-haspopup="menu"]').tap();
      await page.getByRole('button', { name: 'Delete Another roadmap' }).tap();
      await page.getByRole('button', { name: 'Delete', exact: true }).tap();
      const nextAction = page.getByRole('menuitem', { name: 'New tree', exact: true });
      await nextAction.focus();
      await page.evaluate(() => window.finishDelete());
      await page.getByRole('button', { name: 'Delete Another roadmap' }).waitFor({ state: 'detached' });
      assert.equal(await nextAction.evaluate((button) => document.activeElement === button), true);
    }, { engine, width: 744, touch: true });
  });

  for (const action of ['rename', 'delete']) {
    test(`${engine}: a device claim while ${action} is open cannot use a server mutation callback`, async () => {
      await withSwitcher([{ id: 'device', title: 'Device roadmap', origin: 'device', claimed: false }], async (page) => {
        await page.locator('#fixture [aria-haspopup="menu"]').tap();
        if (action === 'rename') {
          await page.getByRole('button', { name: 'Rename Device roadmap' }).tap();
          await page.getByRole('textbox', { name: 'Tree name' }).fill('Claimed draft');
        } else {
          await page.getByRole('button', { name: 'Delete Device roadmap' }).tap();
        }
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 'device' } })));
        if (action === 'rename') await page.keyboard.press('Enter');
        else await page.getByRole('button', { name: 'Delete', exact: true }).tap();
        assert.deepEqual(await page.evaluate(() => ({ renames: window.renames ?? [], deletes: window.deletes ?? [], previews: window.previews ?? [], events: window.events, hash: location.hash })), {
          renames: [], deletes: [], previews: action === 'rename' ? [['device', 'Claimed draft'], ['device', 'Device roadmap']] : [],
          events: [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }], hash: '',
        });
        const row = page.getByRole('menuitem').filter({ hasText: 'Device roadmap' });
        assert.equal(await row.evaluate((element) => document.activeElement === element), true);
        assert.equal(await row.getByRole('button').count(), 0);
      }, { engine, width: 744, touch: true });
    });
  }
}

async function confirmDeleting(page, title) {
  await page.getByRole('menuitem').filter({ hasText: title }).hover();
  await page.getByRole('button', { name: `Delete ${title}` }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
}

// The confirming row as a person meets it: the question, the line, what Delete is described by, the titles in bold, where
// the ring sits against the question's first line, whether any of its text is cut, and how wide the menu stands.
const confirmingRow = (page) => page.getByRole('button', { name: 'Delete', exact: true }).evaluate((del) => {
  const row = del.closest('[role="menuitem"]');
  const question = row.querySelector('span > span');
  const line = row.querySelector('[id]');
  const ring = row.firstElementChild.getBoundingClientRect();
  const first = question.getBoundingClientRect();
  const cut = [...row.querySelectorAll('span')].some((span) => getComputedStyle(span).textOverflow === 'ellipsis'
    || (getComputedStyle(span).display !== 'inline' && span.scrollWidth > span.clientWidth));
  return {
    question: question.textContent,
    line: line?.textContent ?? null,
    bold: [...(line?.querySelectorAll('strong') ?? [])].map((strong) => strong.textContent),
    describedBy: del.getAttribute('aria-describedby') && document.getElementById(del.getAttribute('aria-describedby')).textContent,
    ring: Math.round(ring.top - first.top) === 2 ? 'first line' : Math.round(ring.top + ring.height / 2 - (row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2)) === 0 ? 'centred' : 'elsewhere',
    cut,
    menu: Math.round(row.closest('[role="menu"]').getBoundingClientRect().width),
  };
});

for (const via of ['blank', 'escape']) {
  test(`Chromium: the identity TreeSwitcher returns focus on ${via} dismissal`, async () => {
    await withSwitcher([], async (page) => {
      const trigger = page.locator('#fixture [aria-haspopup="menu"]');
      await openMenu(page);
      await page.getByRole('menuitem').first().focus();
      if (via === 'blank') await page.locator('#blank').click();
      if (via === 'escape') await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      assert.deepEqual(await trigger.evaluate((button) => ({
        focused: document.activeElement === button,
        expanded: button.getAttribute('aria-expanded'),
        height: button.getBoundingClientRect().height,
        fontSize: getComputedStyle(button).fontSize,
        caret: { width: button.querySelector('svg').getBoundingClientRect().width, opacity: getComputedStyle(button.querySelector('svg')).opacity },
      })), { focused: true, expanded: 'false', height: 44, fontSize: '24px', caret: { width: 20, opacity: '1' } });
    });
  });
}

const server28 = (row) => ({ done: 1, total: 4, dominantKind: 'sky', updatedAt: '2026-11-01T00:00:00Z', origin: 'server', ...row });

test('Chromium: the confirmation names the steps in the person’s other trees that go with the tree, in each of its four forms, and counts the trees it cannot name', async () => {
  const rows = [
    server28({ id: 'sail', title: 'Learn to sail', openers: [{ treeId: 't_summer', steps: 1 }, { treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_life', title: 'My life', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
    server28({ id: 't_read', title: 'Reading list', openers: [{ treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_spanish', title: 'Spanish basics', openers: [{ treeId: 't_summer', steps: 2 }] }),
    server28({ id: 't_health', title: 'Stay healthy', openers: [{ treeId: 't_spanish', steps: 1 }, { treeId: 't_summer', steps: 1 }, { treeId: 't_life', steps: 1 }, { treeId: 't_read', steps: 1 }] }),
    server28({ id: 't_coast', title: 'Coast trip', openers: [{ treeId: 't_gone', steps: 3 }, { treeId: 't_year', steps: 1 }] }),
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const seen = [];
    for (const title of ['Reading list', 'Spanish basics', 'Learn to sail', 'Stay healthy', 'Coast trip']) {
      await confirmDeleting(page, title);
      seen.push(await confirmingRow(page));
      await page.getByRole('button', { name: 'Keep' }).click();
    }
    const formed = (title, line, bold) => ({ question: `Delete ${title}? This can’t be undone`, line, bold, describedBy: line, ring: 'first line', cut: false, menu: 300 });
    assert.deepEqual(seen, [
      formed('Reading list', 'Also removes the step that opens it in My year', ['My year']),
      formed('Spanish basics', 'Also removes 2 steps that open it in Summer plans', ['Summer plans']),
      formed('Learn to sail', 'Also removes 2 steps that open it, in My year and Summer plans', ['My year', 'Summer plans']),
      formed('Stay healthy', 'Also removes 4 steps that open it, in My life, Summer plans and 2 more trees', ['My life', 'Summer plans']),
      formed('Coast trip', 'Also removes 4 steps that open it in 2 of your other trees', []),
    ]);
    assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } }]);
  });
});

test('Chromium: a tree nothing opens, and any tree from a server that sends no openers, asks the question alone, wrapped and centred', async () => {
  const rows = [
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
    server28({ id: 't_old', title: 'A tree the server says nothing about' }),
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const seen = [];
    for (const title of ['Summer plans', 'A tree the server says nothing about']) {
      await confirmDeleting(page, title);
      seen.push(await confirmingRow(page));
      await page.getByRole('button', { name: 'Keep' }).click();
    }
    assert.deepEqual(seen, [
      { question: 'Delete Summer plans? This can’t be undone', line: null, bold: [], describedBy: null, ring: 'centred', cut: false, menu: 300 },
      { question: 'Delete A tree the server says nothing about? This can’t be undone', line: null, bold: [], describedBy: null, ring: 'centred', cut: false, menu: 300 },
    ]);
  });
});

test('Chromium: a delete says whether steps opened the tree and where the tree lived, and a tree deleted first is no longer counted for the trees it opened', async () => {
  const rows = [
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [{ treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_coast', title: 'Coast trip', openers: [{ treeId: 't_summer', steps: 2 }] }),
    server28({ id: 't_old', title: 'Old server row' }),
    { id: 't_draft', title: 'Draft on the device', updatedAt: 0, origin: 'device', claimed: false, openers: [{ treeId: 't_year', steps: 2 }] },
  ];
  await withSwitcher(rows, async (page) => {
    await openMenu(page);
    const lines = [];
    for (const title of ['Summer plans', 'Coast trip', 'Old server row', 'Draft on the device']) {
      await confirmDeleting(page, title);
      lines.push((await confirmingRow(page)).line);
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('menuitem').filter({ hasText: title }).waitFor({ state: 'detached' });
    }
    assert.deepEqual(lines, ['Also removes the step that opens it in My year', null, null, 'Also removes 2 steps that open it in My year']);
    assert.deepEqual(await page.evaluate(() => window.events), [
      { name: 'roadmap_sheet', props: { step: 'open', door: 'switcher' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'some', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'none', place: 'account' } },
      { name: 'roadmap_sheet', props: { step: 'delete', door: 'switcher', openers: 'some', place: 'device' } },
    ]);
  });
});

// The row's Delete as the accessibility tree hands it to a screen reader once a key has put focus on it.
async function focusedButton(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const focused = nodes.find((node) => node.role?.value === 'button' && node.properties?.some((property) => property.name === 'focused' && property.value.value));
  return { name: focused?.name?.value, description: focused?.description?.value };
}

test('Chromium: from the keyboard, Delete is reached and a screen reader hears the line as its description', async () => {
  const rows = [
    server28({ id: 'sail', title: 'Learn to sail', openers: [{ treeId: 't_summer', steps: 1 }, { treeId: 't_year', steps: 1 }] }),
    server28({ id: 't_year', title: 'My year', openers: [] }),
    server28({ id: 't_summer', title: 'Summer plans', openers: [] }),
  ];
  await withSwitcher(rows, async (page) => {
    await page.locator('#fixture [aria-haspopup="menu"]').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    for (const key of ['Tab', 'Tab', 'Tab']) await page.keyboard.press(key);
    assert.deepEqual(await focusedButton(page), { name: 'Delete Learn to sail', description: undefined });
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Delete', exact: true }).waitFor();
    assert.deepEqual(await focusedButton(page), { name: 'Delete', description: 'Also removes 2 steps that open it, in My year and Summer plans' });
  });
});
