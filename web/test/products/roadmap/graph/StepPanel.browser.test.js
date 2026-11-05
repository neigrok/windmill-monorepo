// The dock's Kind section in a browser: the drawn geometry, the hover preview, keys that never write and Manage kinds.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StepPanel } from '/src/products/roadmap/graph/StepPanel.jsx';
const call = (name) => (...args) => window.calls.push([name, ...args]);
window.calls = [];
createRoot(document.getElementById('root')).render(React.createElement('div', { style: { width: 360 } }, React.createElement(StepPanel, {
  node: { id: 'wind', label: 'Read the wind', color: 'sky' }, state: 'available', prerequisites: [],
  legend: [{ id: 'build', hue: 'terracotta', label: 'Build' }, { id: 'learn', hue: 'olive', label: 'Learn' }, { id: 'milestone', hue: 'gold', label: 'Milestone' }],
  onRename: call('rename'), onPreviewKind: call('preview'), onRestoreKind: call('restore'), onSetKind: call('set'), onOpenLegend: call('legend'),
  onAddSubtask: call('addSubtask'), onMarkComplete: call('complete'), onReset: call('reset'), onDelete: call('delete'), onPreviewDeleteCost: call('previewDelete'), onClearDeleteCost: call('clearDelete'), onClose: call('close'),
})));
`;

let browser, server, origin, ready;
function start() {
  ready ??= (async () => {
    server = await createServer({
      configFile: false, root, cacheDir: `${root}/node_modules/.vite-step-panel-test`,
      plugins: [{ name: 'step-panel-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/step-panel-entry.js') return '\0step-panel-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0step-panel-beacon';
        },
        load(id) {
          if (id === '\0step-panel-entry') return entry;
          if (id === '\0step-panel-beacon') return beacon;
        },
        configureServer(host) {
          host.middlewares.use('/step-panel-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Step panel test</title><div id="root"></div><script type="module" src="/step-panel-entry.js"></script>');
          });
        },
      }],
      optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
  })();
  return ready;
}
after(async () => {
  await ready?.catch(() => {});
  await browser?.close();
  await server?.close();
});

async function openPanel() {
  await start();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/step-panel-test`);
  await page.getByRole('radiogroup', { name: 'Kind', exact: true }).waitFor();
  return page;
}

test('Chromium: the Kind section stands as drawn in 08.11: heading row, Manage kinds at Body/12.5 · 700 in brand, 34px chips in 44px targets', async () => {
  const page = await openPanel();
  try {
    await withBrowserErrors(page, async () => {
      assert.deepEqual(await page.evaluate(() => {
        const section = document.querySelector('.st-step-kind').getBoundingClientRect();
        const heading = document.querySelector('.st-step-kind-heading').getBoundingClientRect();
        const group = document.querySelector('.st-step-kind [role="radiogroup"]').getBoundingClientRect();
        const manage = document.querySelector('.st-step-manage-kinds');
        const style = getComputedStyle(manage);
        const probe = document.createElement('i');
        probe.style.color = 'var(--color-brand)';
        document.body.append(probe);
        const brand = getComputedStyle(probe).color;
        probe.remove();
        const chips = [...document.querySelectorAll('.st-board-draft-kind-choice')];
        return {
          heading: Math.round(heading.height),
          gap: Math.round(group.top - heading.bottom),
          manageRight: Math.round(section.right - manage.getBoundingClientRect().right),
          manage: [style.fontSize, style.fontWeight, style.lineHeight, style.color === brand],
          targets: chips.map((chip) => Math.round(chip.getBoundingClientRect().height)),
          surfaces: chips.map((chip) => Math.round(chip.firstElementChild.getBoundingClientRect().height)),
          rows: new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
        };
      }), {
        heading: 18, gap: 6, manageRight: 0, manage: ['12.5px', '700', '18px', true],
        targets: [44, 44, 44, 44, 44, 44], surfaces: [34, 34, 34, 34, 34, 34], rows: 2,
      });
    });
  } finally {
    await page.close();
  }
});

test('Chromium: hovering previews on the node, arrow keys only move focus, a press saves, and the kind in force writes nothing', async () => {
  const page = await openPanel();
  try {
    await withBrowserErrors(page, async () => {
      const group = page.getByRole('radiogroup', { name: 'Kind', exact: true });
      await group.getByRole('radio', { name: 'Brick', exact: true }).hover();
      await page.mouse.move(0, 0);
      assert.deepEqual(await page.evaluate(() => window.calls), [['preview', 'wind', 'brick'], ['restore', 'wind']]);
      await page.evaluate(() => { window.calls.length = 0; });

      await group.getByRole('radio', { name: 'Sky', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      assert.deepEqual(await page.evaluate(() => [document.activeElement.textContent, window.calls]), ['Build', []]);
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.calls), [['set', 'wind', 'terracotta']]);

      await page.evaluate(() => { window.calls.length = 0; });
      await group.getByRole('radio', { name: 'Sky', exact: true }).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.calls), []);
    });
  } finally {
    await page.close();
  }
});

test('Chromium: Manage kinds opens the legend', async () => {
  const page = await openPanel();
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Manage kinds', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.calls), [['legend']]);
    });
  } finally {
    await page.close();
  }
});

test('Chromium: the add menu says Subtask, and its row asks for one by the drawn name', async () => {
  const page = await openPanel();
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Add to this step', exact: true }).click();
      assert.deepEqual(await page.getByRole('menuitem').allInnerTexts(), ['Subtask', 'Note', 'Link']);
      await page.getByRole('menuitem', { name: 'Subtask', exact: true }).click();
      assert.equal(await page.locator('.st-check-head').innerText(), 'SUBTASKS\n0 of 0');
      const row = page.getByPlaceholder('Add subtask', { exact: true });
      await row.fill('Identify the halyard');
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.calls), [['addSubtask', 'wind', 'Identify the halyard']]);
    });
  } finally {
    await page.close();
  }
});
