import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, boardEvents, learnToSailNodes, withBrowserErrors } from '../browserFixture.js';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: BoardView } = await import('../../../../src/products/roadmap/board/BoardView.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { ANONYMOUS_OWNER, createdToast } = await import('../../../../src/products/roadmap/copy.js');

for (const breakpoint of ['desktop', 'tablet', 'phone']) {
  test(`BoardView notices: ${breakpoint} keeps the device line and Fork offer on phones`, () => {
    const html = renderToStaticMarkup(React.createElement(BoardView, {
      tree: new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: learnToSailNodes }),
      completed: new Set(['course', 'parts', 'rig']), completedAt: {}, breakpoint,
      onSelect: () => {}, deviceLine: { text: ANONYMOUS_OWNER, onSignIn: () => {} }, onFork: () => {},
    }));
    assert.deepEqual({
      deviceLine: html.includes('board-device-line'),
      fork: html.includes('Fork this tree'),
      complete: html.includes('st-board-swipe-complete'),
      create: html.includes('New step'),
    }, { deviceLine: breakpoint === 'phone', fork: breakpoint === 'phone', complete: false, create: false });
  });
}

for (const breakpoint of ['desktop', 'phone']) {
  for (const state of ['empty', 'complete']) {
    test(`BoardView notices: ${breakpoint} reader ${state} state offers no New step`, () => {
      const nodes = state === 'empty' ? [] : learnToSailNodes;
      const html = renderToStaticMarkup(React.createElement(BoardView, {
        tree: new SkillTree({ id: 'sail', title: 'Learn to sail', nodes }),
        completed: new Set(nodes.map(({ id }) => id)), completedAt: {}, breakpoint, onSelect: () => {},
      }));
      assert.deepEqual({
        empty: html.includes('Your first step'),
        complete: html.includes('All 8 steps done'),
        create: html.includes('New step'),
      }, { empty: state === 'empty', complete: state === 'complete', create: false });
    });
  }
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import BoardView from '/src/products/roadmap/board/BoardView.jsx';
import { StepDetail } from '/src/products/roadmap/step/StepDetail.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import { BoardQuery } from '/src/products/roadmap/board/Board.js';
import { ANONYMOUS_OWNER } from '/src/products/roadmap/copy.js';

window.openRoom = (nodes, options = {}) => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes });
  const band = window.innerWidth < 744 ? 'phone' : window.innerWidth < 1280 ? 'tablet' : 'desktop';
  const completed = new Set(options.completed ?? ['course', 'parts', 'rig']);
  const completedAt = { course: 1, parts: 2, rig: 3 };
  const call = (name) => (window.calls ??= []).push(name);
  function Room() {
    const [refused, setRefused] = useState(options.refusal ?? null);
    const [query, setQuery] = useState(() => new BoardQuery());
    const [address, setAddress] = useState(null);
    const retry = useCallback(() => { call('retry'); setRefused(null); }, []);
    const discard = useCallback(() => { call('discard'); setRefused(null); }, []);
    const signIn = useCallback(() => call('sign_in'), []);
    const fork = useCallback(() => call('fork'), []);
    const close = useCallback(() => setAddress(null), []);
    const select = useCallback((id) => setAddress({ id, trail: [id], door: 'card' }), []);
    window.clearRefusal = () => setRefused(null);
    window.showRefusal = setRefused;
    return React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'st-view-layer--board is-active', style: { position: 'fixed', inset: 0 } },
        React.createElement(BoardView, {
          tree, completed, completedAt, active: true, breakpoint: band, topInset: 110,
          query, onQuery: setQuery, onSelect: select,
          toast: options.toast, onToastShown: () => call('toast_shown'),
          deviceLine: options.device ? { text: ANONYMOUS_OWNER, onSignIn: signIn } : null,
          refusal: refused && { ...refused, onRetry: retry, onDiscard: discard },
          onFork: options.reader && band === 'phone' ? fork : null,
        })),
      address && React.createElement(StepDetail, {
        tree, completed, completedAt, address, breakpoint: band, roadmapTitle: 'Learn to sail',
        editable: false, deletable: false, onBack: close, onClose: close, onOpenStep: select,
        stepLink: 'https://windmill.test/t/sail#?step=' + address.id,
        onOpenInGraph: () => call('graph'), onNotify: () => {},
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(Room));
};
window.entryReady = true;
`;

let server, browser, origin, starting;
function ready() {
  starting ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-board-notices-test`,
      plugins: [{ name: 'board-notices-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/board-notices-entry.js') return '\0board-notices-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0board-notices-beacon';
        },
        load(id) {
          if (id === '\0board-notices-entry') return entry;
          if (id === '\0board-notices-beacon') return beacon;
        },
        configureServer(server) {
          server.middlewares.use('/board-notices-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/board-notices-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } },
    });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return starting;
}
after(async () => {
  try { await starting; } finally { await browser?.close(); await server?.close(); }
});

async function inRoom(width, options, run) {
  await ready();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await withBrowserErrors(page, async () => {
      await page.clock.install({ time: new Date('2026-11-03T11:59:00Z') });
      await page.clock.pauseAt(new Date('2026-11-03T12:00:00Z'));
      await page.goto(`${origin}/board-notices-test`);
      await page.waitForFunction(() => window.entryReady);
      await page.evaluate(([nodes, options]) => openRoom(nodes, options), [learnToSailNodes, options]);
      await page.locator('.st-board').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await run(page);
    });
  } finally { await page.close(); }
}

for (const width of [1440, 744, 390, 320]) {
  test(`Chromium Board notices: ${width}px refusal clears the strip, pane, band and Find`, async () => {
    await inRoom(width, { refusal: { code: 'bad-frame', count: 3 } }, async (page) => {
      assert.deepEqual([
        await page.locator('.board-refused-sync-message').textContent(),
        await page.getByRole('alert').getByRole('button').allTextContents(),
      ], ['Couldn’t sync 3 changes.', ['Discard 3 changes', 'Retry']]);
      assert.deepEqual(await page.evaluate(() => {
        const refusal = document.querySelector('[data-board-refusal]').getBoundingClientRect();
        const band = document.querySelector('.st-board-phone-band')?.getBoundingClientRect();
        const pane = document.querySelector('.st-board-phone-panes')?.getBoundingClientRect();
        const strip = document.querySelector('.st-board-strip')?.getBoundingClientRect();
        const columns = document.querySelector('.st-board-columns')?.getBoundingClientRect();
        const find = document.querySelector('.st-board-find-input')?.getBoundingClientRect();
        return {
          aboveBand: !band || refusal.bottom <= band.top,
          belowPane: !pane || pane.bottom <= refusal.top,
          belowStrip: !strip || strip.bottom <= refusal.top,
          aboveColumns: !columns || refusal.bottom <= columns.top,
          clearFind: !find || refusal.bottom <= find.top || refusal.top >= find.bottom,
          inViewport: refusal.left >= 0 && refusal.right <= window.innerWidth,
        };
      }), { aboveBand: true, belowPane: true, belowStrip: true, aboveColumns: true, clearFind: true, inViewport: true });
      assert.equal(await page.locator('[data-column] [role="alert"]').count(), 0);
      const heights = await page.locator(width < 744 ? '.st-board-phone-panes' : '.st-board-columns').evaluate((node) => node.clientHeight);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.matches('.st-board-card[tabindex="0"]')), true);
      assert.ok(await page.locator(width < 744 ? '.st-board-phone-panes' : '.st-board-columns').evaluate((node) => node.clientHeight) > heights);
      assert.deepEqual(await page.evaluate(() => window.calls), ['retry']);
    });
  });

  test(`Chromium Board notices: ${width}px device row is phone only and opens sign in`, async () => {
    await inRoom(width, { device: true }, async (page) => {
      const line = page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true });
      assert.equal(await line.count(), width < 744 ? 1 : 0);
      if (width >= 744) return;
      await line.click();
      assert.deepEqual(await page.evaluate(() => window.calls), ['sign_in']);
      assert.deepEqual(await line.evaluate((node) => ({
        top: node.getBoundingClientRect().top,
        textLeft: node.firstElementChild.getBoundingClientRect().left,
        clearPane: node.getBoundingClientRect().bottom <= document.querySelector('.st-board-phone').getBoundingClientRect().top,
      })), { top: 110, textLeft: 16, clearPane: true });
    });
  });
}

for (const action of ['discard', 'drain']) {
  test(`Chromium Board notices: ${action} returns focus from the disappearing refusal`, async () => {
    await inRoom(390, { refusal: { code: 'tree-too-large', count: 3 } }, async (page) => {
      assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Discard 3 changes', exact: true }).focus();
      if (action === 'discard') await page.keyboard.press('Enter');
      else await page.evaluate(() => clearRefusal());
      await page.getByRole('alert').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.matches('.st-board-card[tabindex="0"]')), true);
    });
  });
}

for (const width of [390, 320]) {
  test(`Chromium reader Board: ${width}px Fork offer is before the band and emits its bounded event`, async () => {
    await inRoom(width, { reader: true }, async (page) => {
      const offer = page.getByRole('button', { name: 'Fork this tree', exact: true });
      assert.equal(await offer.evaluate((node) => {
        const band = document.querySelector('.st-board-phone-band');
        return Boolean(node.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING)
          && node.getBoundingClientRect().bottom <= band.getBoundingClientRect().top
          && node.getBoundingClientRect().width === document.querySelector('.st-board-phone').clientWidth;
      }), true);
      await offer.click();
      assert.deepEqual(await page.evaluate(() => window.calls), ['fork']);
      assert.deepEqual(await boardEvents(page), ['roadmap_verb {"verb":"fork","door":"offer","view":"board","band":"phone"}']);
    });
  });
}

for (const width of [1440, 390]) {
  test(`Chromium reader Board: ${width}px cards and real step detail expose no writes`, async () => {
    await inRoom(width, { reader: true }, async (page) => {
      assert.equal(await page.getByRole('button', { name: 'New step', exact: true }).count(), 0);
      assert.equal(await page.locator('.st-board-swipe, .st-board-swipe-complete').count(), 0);
      const card = page.locator('.st-board-card[data-step-id="wind"]');
      await card.focus();
      for (const key of ['c', 'Backspace', 'Delete']) await page.keyboard.press(key);
      assert.deepEqual(await page.evaluate(() => window.calls ?? []), []);
      assert.equal(await page.locator('.st-board-card[data-step-id="wind"]').count(), 1);
      await card.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200, button: 0 });
      await page.clock.runFor(1000);
      await card.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 100, clientY: 200, button: 0 });
      await card.dispatchEvent('click');
      assert.equal(await page.locator('.st-board-bulk').count(), 0);
      assert.equal(await page.getByRole('dialog').count(), 0);
      await card.click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').getByRole('tab').count(), 0);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Copy link', 'Open in Graph']);
      for (const name of ['Workspace', 'History', 'Edit step', 'Complete', 'Reset', 'Delete step']) {
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
      }
    });
  });
}

test('Chromium Board notices: an empty phone pane receives focus after the refusal clears', async () => {
  await inRoom(390, { completed: learnToSailNodes.map(({ id }) => id), refusal: { code: 'bad-frame' } }, async (page) => {
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.matches('.st-board-phone-pane.is-shown[tabindex="0"]')), true);
  });
});


for (const width of [320, 390]) {
  test(`Chromium Board notices: ${width}px a held delete stands above the refused card, clear of it and of the band, and its hold runs`, async () => {
    const toast = { key: 1, act: 'delete', overRefusal: true, message: 'Read the wind deleted', action: { label: 'Undo' } };
    await inRoom(width, { refusal: { code: 'bad-frame', count: 1 }, toast }, async (page) => {
      await page.getByRole('alert').waitFor();
      await page.clock.runFor(120);
      await page.locator('.st-board-toast').waitFor();
      assert.deepEqual(await page.evaluate(() => window.calls), ['toast_shown']);
      assert.deepEqual(await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish();
        const toast = document.querySelector('.st-board-toast').getBoundingClientRect();
        const refusal = document.querySelector('[data-board-refusal]').getBoundingClientRect();
        const band = document.querySelector('.st-board-phone-band').getBoundingClientRect();
        const pane = document.querySelector('.st-board-phone-panes').getBoundingClientRect();
        return {
          aboveCard: toast.bottom <= refusal.top,
          gap: refusal.top - toast.bottom,
          overPane: toast.top >= pane.top,
          aboveBand: toast.bottom <= band.top,
          sameEdges: Math.abs(toast.left - refusal.left) < 1 && Math.abs(toast.right - refusal.right) < 1,
          inViewport: toast.left >= 0 && toast.right <= window.innerWidth,
        };
      }), { aboveCard: true, gap: 8, overPane: true, aboveBand: true, sameEdges: true, inViewport: true });
      await page.getByRole('button', { name: 'Undo', exact: true }).click({ trial: true });
      await page.getByRole('button', { name: 'Retry', exact: true }).click({ trial: true });
    });
  });

  test(`Chromium Board notices: ${width}px refusal and creation toast never overlap`, async () => {
    const toast = { key: 1, message: createdToast({ step: 'Read the wind', column: 'upNext' }), action: { label: 'Undo' } };
    await inRoom(width, { refusal: { code: 'bad-frame', count: 1 }, toast }, async (page) => {
      await page.getByRole('alert').waitFor();
      await page.clock.runFor(6000);
      assert.equal(await page.locator('.st-board-toast').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.calls ?? []), []);
      await page.evaluate(() => window.clearRefusal());
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.clock.runFor(120);
      await page.locator('.st-board-toast').waitFor();
      assert.deepEqual(await page.evaluate(() => window.calls), ['toast_shown']);
      await page.evaluate(() => window.showRefusal({ code: 'bad-frame', count: 1 }));
      await page.getByRole('alert').waitFor();
      assert.equal(await page.locator('.st-board-toast').count(), 0);
    });
  });
}
