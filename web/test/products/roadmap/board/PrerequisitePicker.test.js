import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as actualBeacon from '../../../../src/telemetry/beacon.js';
import { parse } from 'acorn';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { beacon, fixtureNodes, formReturned } from './composerFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function withoutWind(nodes) {
  return nodes.filter((node) => node.id !== 'wind').map((node) => ({
    ...node,
    prerequisites: node.prerequisites.filter((id) => id !== 'wind'),
  }));
}

const entry = `
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import { StepComposer } from '/src/products/roadmap/board/StepComposer.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const completed = new Set(['wind']);
const fixtureNodes = ${fixtureNodes.toString()};
const withoutWind = ${withoutWind.toString()};
window.mount = ({ total = 8, editing = null } = {}) => {
  const original = fixtureNodes(total);
  if (editing) {
    original[2].prerequisites = [];
    original[1].prerequisites.push(original[2].id);
  }
  function App() {
    const [open, setOpen] = useState(false);
    const [nodes, setNodes] = useState(original);
    const [width, setWidth] = useState(innerWidth);
    const tree = useMemo(() => new SkillTree({ id: 'sail', title: 'Learn to sail', nodes }), [nodes]);
    useEffect(() => {
      const resize = () => setWidth(innerWidth);
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, []);
    window.remove = () => setNodes(withoutWind(original));
    window.blockSelected = () => setNodes(original.map((node) => {
      if (node.id === 'step-0') return { ...node, prerequisites: ['wind'] };
      if (node.id === 'step-1') return { ...node, prerequisites: ['step-0'] };
      return node;
    }));
    window.refresh = () => setNodes((current) => [...current]);
    window.restore = () => setNodes(original);
    window.nodeCount = tree.nodes.length;
    return React.createElement('div', null,
      React.createElement('button', { onClick: () => setOpen(true) }, 'Open composer'),
      open && React.createElement(StepComposer, {
        tree, completed, legend: [], editing,
        band: width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop',
        onClose: () => setOpen(false),
        onEdit: (request) => {
          (window.requests ??= []).push(request);
          return { ok: false };
        },
        onCreate: (request) => {
          (window.requests ??= []).push(request);
          return { ok: false };
        },
      }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;

let server, browser, origin, launching;
const serving = (async () => {
  server = await createServer({
    configFile: false,
    root,
    cacheDir: `${root}/node_modules/.vite-prerequisite-picker-test`,
    plugins: [{
      name: 'picker-test',
      enforce: 'pre',
      resolveId(id) {
        if (id === '/picker-test-entry.js') return '\0picker-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0picker-beacon';
      },
      load(id) {
        if (id === '\0picker-entry') return entry;
        if (id === '\0picker-beacon') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/picker-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/picker-test-entry.js"></script>');
        });
      },
    }],
    optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: {
      host: '127.0.0.1', port: 0,
      fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] },
    },
  });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
})();

after(async () => {
  await serving;
  await browser?.close();
  await server?.close();
});

async function open(width, { total = 8, selected = [], name = 'Reefing basics', editing = null } = {}) {
  await serving;
  launching ??= chromium.launch({ headless: true });
  browser = await launching;
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${origin}/picker-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((options) => window.mount(options), { total, editing });
    await page.getByRole('button', { name: 'Open composer' }).click();
    if (name) await page.getByLabel('Name', { exact: true }).fill(name);
    await page.locator('.st-board-draft-needs').click();
    await page.locator('.st-board-picker').waitFor();
    if (selected.length > 0) {
      for (const id of selected) {
        const label = id === 'wind' ? 'Read the wind Done' : `Chart ${id.slice(5)} Up next`;
        await page.getByRole('checkbox', { name: label, exact: true }).click();
      }
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await formReturned(page);
      await page.locator('.st-board-draft-needs').click();
      await page.locator('.st-board-picker').waitFor();
    }
    await page.evaluate(() => { window.events = []; });
    return { page, errors };
  } catch (error) {
    await page.close();
    assert.deepEqual(errors, []);
    throw error;
  }
}

test('Picker fixtures stay valid through removal and restoration and their full entry transforms', async () => {
  for (const total of [8, 65]) {
    const original = fixtureNodes(total);
    const reduced = withoutWind(original);
    const tree = new SkillTree({ id: 'sail', title: '', nodes: reduced });
    assert.equal(tree.nodes.length, total - 1);
    assert.deepEqual(tree.nodes.map((node) => node.prerequisites), Array.from({ length: total - 1 }, () => []));
    assert.equal(new SkillTree({ id: 'sail', title: '', nodes: original }).nodes.length, total);
  }
  await serving;
  parse(entry, { ecmaVersion: 'latest', sourceType: 'module' });
  for (const source of ['/picker-test-entry.js', '/src/products/roadmap/board/PrerequisitePicker.jsx']) {
    const transformed = await server.transformRequest(source);
    assert.ok(transformed?.code, source);
    parse(transformed.code, { ecmaVersion: 'latest', sourceType: 'module' });
  }
  const resolved = await server.pluginContainer.resolveId('../../../telemetry/beacon.js', `${root}src/products/roadmap/board/PrerequisitePicker.jsx`);
  assert.equal(resolved.id, '\0picker-beacon');
  const stub = await server.ssrLoadModule('\0picker-beacon');
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(actualBeacon).sort());
  const acts = await server.ssrLoadModule('/src/products/roadmap/board/acts.js');
  assert.deepEqual([0, 1, 2, 6, 21].map(acts.countBucket), ['0', '1', '2-5', '6-20', '21+']);
});

for (const width of [390, 1440]) {
  test(`Chromium ${width}: query changes preserve selection and Cancel restores the draft`, async () => {
    const { page, errors } = await open(width, { selected: ['wind'] });
    try {
      const apply = page.getByRole('button', { name: 'Apply', exact: true });
      assert.equal(await apply.isDisabled(), true);
      await page.getByLabel('Find a step', { exact: true }).fill('Chart 2');
      await page.getByRole('checkbox', { name: 'Chart 2 Up next', exact: true }).click();
      await page.getByLabel('Find a step', { exact: true }).fill('no match');
      await page.getByRole('heading', { name: 'No steps match “no match”', exact: true }).waitFor();
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(), ['Read the wind', 'Chart 2']);
      assert.equal(await page.locator('.st-board-picker-empty p').textContent(), 'Your selection is kept.');
      await page.getByRole('button', { name: 'Remove Chart 2', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.st-board-picker-chip').length === 1);
      assert.equal(await apply.isDisabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement !== document.body && !!document.activeElement.closest('[role="dialog"]')), true);
      assert.equal(await page.getByLabel('Find a step', { exact: true }).evaluate((element) => element === document.activeElement), width >= 744);
      await page.keyboard.press('Escape');
      await formReturned(page);
      assert.equal(await page.locator('.st-board-draft-needs').textContent(), 'PrerequisitesRead the wind');
      assert.deepEqual(await page.evaluate(() => ({ requests: window.requests ?? [], events: window.events })), {
        requests: [], events: [{ name: 'roadmap_board_picker', props: { step: 'cancel', mode: 'create' } }],
      });
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: 'Chart 2 Up next', exact: true }).click();
      await apply.click();
      await formReturned(page);
      assert.equal(await page.locator('.st-board-draft-needs').textContent(), 'PrerequisitesRead the wind, Chart 2');
      assert.deepEqual(await page.evaluate(() => window.events.at(-1)), {
        name: 'roadmap_board_picker', props: { step: 'apply', mode: 'create', count: '2-5' },
      });
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: pages contain twenty more results and Backspace removes the last chip`, async () => {
    const { page, errors } = await open(width, { total: 65, selected: ['wind', 'step-0'] });
    try {
      assert.equal(await page.getByRole('checkbox').count(), 20);
      await page.getByLabel('Find a step', { exact: true }).fill('Chart');
      await page.waitForFunction(() => document.querySelector('.st-board-picker-count')?.textContent.includes('64 matches'));
      assert.equal(await page.locator('.st-board-picker-count').textContent(), width < 744 ? '20 of 64 matches' : '20 of 64 matches in 65 steps');
      await page.getByRole('button', { name: 'Show 20 more' }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="checkbox"]').length === 40);
      await page.getByRole('button', { name: 'Show 20 more' }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="checkbox"]').length === 60);
      await page.getByRole('button', { name: 'Show 4 more' }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('[role="checkbox"]').length === 64);
      assert.equal(await page.locator('.st-board-picker-more').count(), 0);
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.st-board-picker')), true);
      assert.deepEqual(await page.evaluate(() => window.events), Array.from({ length: 3 }, () => ({
        name: 'roadmap_board_picker', props: { step: 'more', mode: 'create' },
      })));
      await page.getByLabel('Find a step', { exact: true }).fill('');
      await page.keyboard.press('Backspace');
      await page.waitForFunction(() => document.querySelectorAll('.st-board-picker-chip').length === 1);
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(), ['Read the wind']);
      await page.getByRole('button', { name: 'Apply', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: remote removal persists after restoration without unmounting the picker`, async () => {
    const { page, errors } = await open(width, { selected: ['wind'] });
    try {
      await page.getByRole('checkbox', { name: 'Read the wind Done', exact: true }).focus();
      await page.evaluate(() => window.remove());
      await page.waitForFunction(() => window.nodeCount === 7 && document.querySelectorAll('[role="checkbox"]').length === 7);
      assert.equal(await page.locator('.st-board-picker').count(), 1);
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.st-board-picker')), true);
      assert.deepEqual(await page.getByRole('checkbox').allTextContents(), Array.from({ length: 7 }, (_, index) => `Chart ${index}Up next`));
      assert.equal(await page.locator('.st-board-picker-chip').count(), 0);
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.restore());
      await page.waitForFunction(() => window.nodeCount === 8 && document.querySelectorAll('[role="checkbox"]').length === 8);
      assert.equal(await page.getByRole('checkbox', { name: 'Read the wind Done', exact: true }).getAttribute('aria-checked'), 'false');
      assert.equal(await page.locator('.st-board-picker-chip').count(), 0);
      await page.keyboard.press('Escape');
      await formReturned(page);
      assert.equal(await page.locator('.st-board-draft-needs').textContent(), 'PrerequisitesNone');
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: no-match copy never claims a nonexistent selection`, async () => {
    const { page, errors } = await open(width);
    try {
      await page.getByLabel('Find a step', { exact: true }).fill('astronomy');
      await page.getByRole('heading', { name: 'No steps match “astronomy”', exact: true }).waitFor();
      assert.equal(await page.locator('.st-board-picker-empty p').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Clear search', exact: true }).count(), 2);
      assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => window.events), []);
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}

for (const width of [744, 1440]) {
  test(`Chromium ${width}: slash focuses search without entering text and small-roadmap counts stay short`, async () => {
    const { page, errors } = await open(width);
    try {
      await page.getByRole('checkbox', { name: 'Chart 2 Up next', exact: true }).focus();
      await page.keyboard.press('/');
      await page.waitForFunction(() => document.activeElement.matches('.st-board-picker-search input'));
      assert.equal(await page.getByLabel('Find a step', { exact: true }).inputValue(), '');
      await page.getByLabel('Find a step', { exact: true }).fill('Chart 2');
      await page.waitForFunction(() => document.querySelectorAll('[role="checkbox"]').length === 1);
      assert.equal(await page.locator('.st-board-picker-count').textContent(), '1 match');
      await page.keyboard.type('/');
      assert.equal(await page.getByLabel('Find a step', { exact: true }).inputValue(), 'Chart 2/');
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}

test('Chromium phone: eight candidates keep keyboard down, nine focus search, and an unnamed draft has no context', async () => {
  for (const total of [8, 9]) {
    const { page, errors } = await open(390, { total, name: '' });
    try {
      await page.waitForFunction((searchExpected) => {
        const searchFocused = document.activeElement.matches('.st-board-picker-search input');
        return searchFocused === searchExpected && document.activeElement !== document.body;
      }, total === 9);
      assert.equal(await page.getByLabel('Find a step', { exact: true }).evaluate((element) => element === document.activeElement), total === 9);
      assert.equal(await page.locator('.st-board-picker-context').count(), 0);
      if (total === 8) {
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.getByLabel('Find a step', { exact: true }).evaluate((element) => element === document.activeElement), true);
      }
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  }
});

test('Chromium phone: the composer owns one visual-viewport box and Apply stays above the keyboard', async () => {
  const { page, errors } = await open(390, { total: 65 });
  try {
    await page.evaluate(() => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, value: 500 },
        offsetTop: { configurable: true, value: 40 },
      });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => document.querySelector('.st-board-composer').getBoundingClientRect().height === 500);
    assert.deepEqual(await page.locator('.st-board-composer').evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      height: element.getBoundingClientRect().height,
    })), { top: 40, height: 500 });
    assert.equal(await page.getByRole('button', { name: 'Apply', exact: true }).evaluate((element) => element.getBoundingClientRect().bottom <= 540), true);
    assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('Chromium: a whitespace-only query on a large roadmap keeps the All steps count', async () => {
  const { page, errors } = await open(1440, { total: 65 });
  try {
    await page.getByLabel('Find a step', { exact: true }).fill('   ');
    await page.waitForFunction(() => document.querySelector('.st-board-picker-search input').value === '   '
      && document.querySelector('.st-board-picker-count').textContent === 'All steps');
    assert.equal(await page.getByRole('checkbox').count(), 20);
    assert.equal(await page.getByRole('button', { name: 'Show 20 more', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.events), []);
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
  }
});


for (const width of [390, 1440]) {
  test(`Chromium ${width}: edit revalidation removes the candidate from both selections and announces once`, async () => {
    const { page, errors } = await open(width, { total: 65, editing: 'step-0', name: null });
    try {
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(), ['Read the wind', 'Chart 1']);
      await page.evaluate(() => window.blockSelected());
      const notice = page.getByText('Chart 1 now comes after this step, so it left your selection.', { exact: true });
      await notice.waitFor();
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(), ['Read the wind']);
      assert.equal(await page.getByRole('checkbox', { name: 'Chart 1 Now comes after this step', exact: true }).getAttribute('aria-disabled'), 'true');
      assert.deepEqual(await page.evaluate(() => window.events), [
        { name: 'roadmap_board_picker', props: { step: 'revalidated', mode: 'edit' } },
      ]);
      await page.evaluate(() => window.refresh());
      await page.getByRole('button', { name: 'Show 20 more', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.st-board-picker-row:not(.is-blocked)').length === 40);
      assert.equal(await notice.isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.events), [
        { name: 'roadmap_board_picker', props: { step: 'revalidated', mode: 'edit' } },
        { name: 'roadmap_board_picker', props: { step: 'more', mode: 'edit' } },
      ]);
      await page.getByLabel('Find a step', { exact: true }).fill('Chart 1');
      await notice.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('checkbox', { name: 'Chart 1 Comes after this step', exact: true }).getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Escape');
      await formReturned(page, 'Edit step');
      assert.equal(await page.locator('.st-board-draft-needs').textContent(), 'PrerequisitesRead the wind');
      await page.getByLabel('Name', { exact: true }).fill('Updated chart');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.requests), [
        { id: 'step-0', label: 'Updated chart', description: '', color: 'olive', prerequisites: ['wind'] },
      ]);
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Chart 0');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.st-board-composer-layer').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => ({ requests: window.requests, event: window.events.at(-1) })), {
        requests: [{ id: 'step-0', label: 'Updated chart', description: '', color: 'olive', prerequisites: ['wind'] }],
        event: { name: 'roadmap_board_edit', props: { step: 'unchanged' } },
      });
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}
