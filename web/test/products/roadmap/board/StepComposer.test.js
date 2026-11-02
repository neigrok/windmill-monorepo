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

const entry = `
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/shell/chrome/chrome.css';
import { StepComposer } from '/src/products/roadmap/board/StepComposer.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const completed = new Set();
const legend = [
  { hue: 'terracotta', label: 'Build' },
  { hue: 'olive', label: 'Learn' },
  { hue: 'gold', label: 'Milestone' },
];
const fixtureNodes = ${fixtureNodes.toString()};
window.mount = ({ empty = false, total = 1, shell = false } = {}) => {
  function App() {
    const [open, setOpen] = useState(false);
    const [width, setWidth] = useState(innerWidth);
    const [nodes, setNodes] = useState(empty ? [] : fixtureNodes(total));
    const tree = useMemo(() => new SkillTree({ id: 'sail', title: 'Learn to sail', nodes }), [nodes]);
    useEffect(() => {
      const resize = () => setWidth(innerWidth);
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, []);
    window.remove = () => setNodes([]);
    window.nodeCount = tree.nodes.length;
    return React.createElement('div', null,
      React.createElement('button', { onClick: () => setOpen(true) }, 'Open composer'),
      open && React.createElement(StepComposer, {
        tree, completed, legend,
        band: width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop',
        onClose: () => setOpen(false),
        onCreate: (request) => {
          (window.requests ??= []).push(request);
          return { ok: !!window.succeed };
        },
      }));
  }
  const app = React.createElement(App);
  createRoot(document.getElementById('root')).render(shell
    ? React.createElement('div', { className: 'wm-shell' },
      React.createElement('header', { className: 'wm-head' }, 'App navigation'),
      React.createElement('main', { className: 'wm-room' }, app))
    : app);
};
window.entryReady = true;
`;

let server, browser, origin, launching;
const serving = (async () => {
  server = await createServer({
    configFile: false,
    root,
    cacheDir: `${root}/node_modules/.vite-step-composer-test`,
    plugins: [{
      name: 'composer-test',
      enforce: 'pre',
      resolveId(id) {
        if (id === '/composer-test-entry.js') return '\0composer-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0composer-beacon';
      },
      load(id) {
        if (id === '\0composer-entry') return entry;
        if (id === '\0composer-beacon') return beacon;
      },
      configureServer(vite) {
        vite.middlewares.use('/composer-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/composer-test-entry.js"></script>');
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

async function open(width, { height = 960, ...options } = {}) {
  await serving;
  launching ??= chromium.launch({ headless: true });
  browser = await launching;
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${origin}/composer-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((options) => window.mount(options), options);
    await page.getByRole('button', { name: 'Open composer' }).click();
    await page.getByRole('dialog', { name: 'New step', exact: true }).waitFor();
    return { page, errors };
  } catch (error) {
    await page.close();
    assert.deepEqual(errors, []);
    throw error;
  }
}

async function closed(page) {
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement.textContent === 'Open composer');
}

test('Composer fixture transforms its complete entry and imports the real action module with a complete beacon stub', async () => {
  await serving;
  const tree = new SkillTree({ id: 'sail', title: '', nodes: fixtureNodes(8) });
  assert.equal(tree.nodes.length, 8);
  assert.deepEqual(tree.nodes.slice(1).map((node) => node.prerequisites), Array.from({ length: 7 }, () => ['wind']));
  parse(entry, { ecmaVersion: 'latest', sourceType: 'module' });
  const sources = [
    '/composer-test-entry.js',
    '/src/products/roadmap/board/StepComposer.jsx',
    '/src/products/roadmap/board/PrerequisitePicker.jsx',
    '/src/products/roadmap/board/acts.js',
  ];
  for (const source of sources) {
    const transformed = await server.transformRequest(source);
    assert.ok(transformed?.code, source);
    parse(transformed.code, { ecmaVersion: 'latest', sourceType: 'module' });
  }
  const resolved = await server.pluginContainer.resolveId('../../../telemetry/beacon.js', `${root}src/products/roadmap/board/StepComposer.jsx`);
  assert.equal(resolved.id, '\0composer-beacon');
  const stub = await server.ssrLoadModule('\0composer-beacon');
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(actualBeacon).sort());
  const acts = await server.ssrLoadModule('/src/products/roadmap/board/acts.js');
  assert.deepEqual([0, 1, 2, 6, 21].map(acts.countBucket), ['0', '1', '2-5', '6-20', '21+']);
});

for (const width of [390, 1440]) {
  test(`Chromium ${width}: required-name treatment follows the frame and Retry preserves the request`, async () => {
    const { page, errors } = await open(width);
    try {
      const name = page.getByLabel('Name', { exact: true });
      await name.focus();
      const normalBorder = await name.evaluate((element) => getComputedStyle(element).borderColor);
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.locator('.st-board-draft-name-error').waitFor();
      const errorId = await name.getAttribute('aria-describedby');
      assert.equal(await page.locator(`[id="${errorId}"]`).textContent(), 'Enter a name for this step.');
      assert.deepEqual(await name.evaluate((element) => {
        const error = document.getElementById(element.getAttribute('aria-describedby'));
        const scroll = document.querySelector('.st-board-composer-scroll');
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-brand)';
        scroll.append(probe);
        const brand = getComputedStyle(probe).color;
        probe.remove();
        return {
          invalid: element.getAttribute('aria-invalid'),
          errorFirst: scroll.firstElementChild === error,
          errorColor: getComputedStyle(error).color,
          brand,
          errorSize: getComputedStyle(error).fontSize,
          errorWeight: getComputedStyle(error).fontWeight,
          border: getComputedStyle(element).borderColor,
        };
      }).then(({ brand, errorColor, ...rest }) => ({ ...rest, brandError: brand === errorColor })), {
        invalid: 'true', errorFirst: true, errorSize: '13px', errorWeight: '400', border: normalBorder, brandError: true,
      });
      await name.fill('  Reefing basics  ');
      await page.getByLabel('Description · optional').fill('Reduce sail in strong wind.');
      await page.getByRole('radio', { name: 'Learn', exact: true }).click();
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.getByRole('alert').waitFor();
      await page.waitForFunction(() => window.events?.some((event) => event.props.step === 'failed'));
      assert.equal(await page.getByRole('alert').textContent(), 'Couldn’t save. Your draft is kept.');
      assert.deepEqual(await page.evaluate(() => {
        const request = window.requests[0];
        const { id, ...fields } = request;
        return { fields, frozen: Object.isFrozen(request), frozenNeeds: Object.isFrozen(request.prerequisites), id: !!id };
      }), {
        fields: { label: 'Reefing basics', description: 'Reduce sail in strong wind.', color: 'olive', prerequisites: [] },
        frozen: true, frozenNeeds: true, id: true,
      });
      await page.evaluate(() => { window.succeed = true; });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await closed(page);
      assert.deepEqual(await page.evaluate(() => ({ same: window.requests[0] === window.requests[1], events: window.events })), {
        same: true,
        events: [
          { name: 'roadmap_board_create', props: { step: 'failed' } },
          { name: 'roadmap_board_create', props: { step: 'retry' } },
        ],
      });
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: clean Escape writes nothing and dirty cancellation asks once`, async () => {
    const { page, errors } = await open(width);
    try {
      await page.keyboard.press('Escape');
      await closed(page);
      assert.deepEqual(await page.evaluate(() => window.requests ?? []), []);
      await page.getByRole('button', { name: 'Open composer' }).click();
      await page.getByLabel('Name', { exact: true }).fill('Reefing basics');
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
      await cancel.click();
      await page.getByRole('dialog', { name: 'Discard draft?', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'Discard draft?', exact: true }).count(), 1);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discard draft?', exact: true }).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.textContent === 'Cancel');
      await cancel.click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await closed(page);
      assert.deepEqual(await page.evaluate(() => ({ requests: window.requests ?? [], events: window.events })), {
        requests: [],
        events: [
          { name: 'roadmap_board_create', props: { step: 'cancel' } },
          { name: 'roadmap_board_create', props: { step: 'discard' } },
        ],
      });
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: Keep editing focuses Name and deletion clears the failed prerequisite request`, async () => {
    const { page, errors } = await open(width);
    try {
      await page.getByLabel('Name', { exact: true }).fill('Reefing basics');
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: 'Read the wind Up next' }).click();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await formReturned(page);
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await page.waitForFunction(() => document.activeElement.matches('.st-board-draft-field input'));
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.getByRole('alert').waitFor();
      await page.evaluate(() => window.remove());
      await page.waitForFunction(() => window.nodeCount === 0 && document.querySelector('.st-board-draft-needs')?.getAttribute('aria-disabled') === 'true');
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.waitForFunction(() => window.requests.length === 3);
      assert.deepEqual(await page.evaluate(() => ({
        sameId: window.requests.every((request) => request.id === window.requests[0].id),
        prerequisites: window.requests.map((request) => request.prerequisites),
      })), { sameId: true, prerequisites: [['wind'], ['wind'], []] });
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });

  test(`Chromium ${width}: an empty roadmap keeps the prerequisite row non-interactive`, async () => {
    const { page, errors } = await open(width, { empty: true });
    try {
      const needs = page.locator('.st-board-draft-needs');
      assert.equal(await needs.textContent(), 'PrerequisitesNone');
      assert.equal(await needs.getAttribute('aria-disabled'), 'true');
      await needs.click({ force: true });
      await needs.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.equal(await page.locator('.st-board-picker').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.events ?? []), []);
      assert.equal(await page.getByRole('dialog', { name: 'New step', exact: true }).count(), 1);
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}

for (const width of [744, 1024, 1439, 1440]) {
  test(`Chromium ${width}: picker fits its layout, traps focus and every exit returns to Prerequisites`, async () => {
    const { page, errors } = await open(width);
    try {
      await page.getByLabel('Name', { exact: true }).fill('Reefing basics');
      const exits = width < 1440 ? ['Back to New step', 'Escape', 'Cancel', 'Apply'] : ['Escape', 'Cancel', 'Apply'];
      for (const exit of exits) {
        await page.locator('.st-board-draft-needs').click();
        await page.locator(`.st-board-picker--${width < 1440 ? 'page' : 'panel'}`).waitFor();
        assert.equal(await page.locator('[aria-modal="true"]').count(), 1);
        assert.equal(await page.locator('[role="dialog"] [role="dialog"]').count(), 0);
        if (width < 1440) assert.equal(await page.locator('[inert]').count(), 0);
        assert.equal(await page.getByRole('dialog', { name: 'Prerequisites', exact: true }).count(), 1);
        assert.deepEqual(await page.evaluate(() => {
          const composer = document.querySelector('.st-board-composer').getBoundingClientRect();
          const picker = document.querySelector('.st-board-picker').getBoundingClientRect();
          return { composerWidth: composer.width, pickerWidth: picker.width, beside: picker.left >= composer.right, within: picker.left >= 0 && picker.right <= innerWidth };
        }), { composerWidth: 600, pickerWidth: width < 1440 ? 560 : 384, beside: width === 1440, within: true });
        if (width < 1440) assert.equal(await page.locator('.st-board-picker-context').textContent(), 'for Reefing basics');
        await page.getByRole('checkbox', { name: 'Read the wind Up next' }).click();
        await page.getByRole('button', { name: 'Apply', exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
        if (exit === 'Escape') await page.keyboard.press('Escape');
        else await page.locator('.st-board-picker').getByRole('button', { name: exit, exact: true }).click();
        await formReturned(page);
        assert.equal(await page.locator('.st-board-draft-needs').textContent(), exit === 'Apply' ? 'PrerequisitesRead the wind' : 'PrerequisitesNone');
      }
      assert.deepEqual(await page.evaluate(() => window.events), exits.flatMap((exit) => [
        { name: 'roadmap_board_picker', props: { step: 'open' } },
        { name: 'roadmap_board_picker', props: exit === 'Apply' ? { step: 'apply', count: '1' } : { step: 'cancel' } },
      ]));
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}

test('Chromium: resizing across page and panel preserves the in-progress search and selection', async () => {
  const { page, errors } = await open(1024);
  try {
    await page.locator('.st-board-draft-needs').click();
    await page.getByLabel('Find a step', { exact: true }).fill('wind');
    await page.getByRole('checkbox', { name: 'Read the wind Up next' }).click();
    for (const width of [1440, 1439, 744, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator(`.st-board-picker--${width < 1440 ? 'page' : 'panel'}`).waitFor();
      assert.equal(await page.getByLabel('Find a step', { exact: true }).inputValue(), 'wind');
      assert.equal(await page.getByRole('checkbox', { name: 'Read the wind Up next' }).getAttribute('aria-checked'), 'true');
      assert.deepEqual(await page.locator('.st-board-picker-chip').allTextContents(), ['Read the wind']);
    }
    assert.deepEqual(await page.evaluate(() => window.events), [{ name: 'roadmap_board_picker', props: { step: 'open' } }]);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await formReturned(page);
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('Chromium: deleting the final candidate closes its picker and leaves a named, non-interactive prerequisite row', async () => {
  const { page, errors } = await open(744);
  try {
    await page.locator('.st-board-draft-needs').click();
    await page.getByRole('checkbox', { name: 'Read the wind Up next' }).click();
    await page.evaluate(() => window.remove());
    await formReturned(page);
    assert.equal(await page.locator('.st-board-draft-needs').getAttribute('aria-disabled'), 'true');
    assert.equal(await page.locator('.st-board-draft-needs').textContent(), 'PrerequisitesNone');
    assert.deepEqual(await page.evaluate(() => ({ requests: window.requests ?? [], events: window.events })), {
      requests: [], events: [{ name: 'roadmap_board_picker', props: { step: 'open' } }],
    });
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
  }
});

test('Chromium 1440×600: the anchored picker and its actions stay inside the short viewport', async () => {
  const { page, errors } = await open(1440, { total: 8 });
  try {
    await page.setViewportSize({ width: 1440, height: 600 });
    await page.locator('.st-board-draft-needs').click();
    await page.locator('.st-board-picker--panel').waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 8);
    await page.waitForFunction(() => {
      const picker = document.querySelector('.st-board-picker').getBoundingClientRect();
      const actions = document.querySelector('.st-board-picker-actions').getBoundingClientRect();
      return picker.bottom <= innerHeight && actions.bottom <= picker.bottom;
    });
    assert.deepEqual(await page.evaluate(() => {
      const composer = document.querySelector('.st-board-composer').getBoundingClientRect();
      const picker = document.querySelector('.st-board-picker').getBoundingClientRect();
      const actions = document.querySelector('.st-board-picker-actions').getBoundingClientRect();
      return {
        beside: picker.left >= composer.right,
        pickerFits: picker.top >= 0 && picker.bottom <= innerHeight,
        actionsFit: actions.top >= picker.top && actions.bottom <= picker.bottom,
      };
    }), { beside: true, pickerFits: true, actionsFit: true });
  } finally {
    await page.close();
    assert.deepEqual(errors, []);
  }
});

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1440, height: 900 }]) {
  test(`Chromium ${viewport.width}×${viewport.height}: composer covers the contained shell before and after name validation`, async () => {
    const { page, errors } = await open(viewport.width, { shell: true, height: viewport.height });
    try {
      assert.deepEqual(await page.locator('.wm-room').evaluate((room) => ({
        top: room.getBoundingClientRect().top,
        contain: getComputedStyle(room).contain,
      })), { top: 52, contain: 'layout paint' });
      const geometry = () => page.evaluate(() => {
        const layer = document.querySelector('.st-board-composer-layer');
        const heading = layer.querySelector('.st-board-draft-heading');
        const action = layer.querySelector('[type="submit"]');
        const rect = layer.getBoundingClientRect();
        const inside = (element) => {
          const box = element.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth
            && element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        };
        return {
          parent: layer.parentElement.tagName,
          rect: [rect.left, rect.top, rect.width, rect.height],
          headingVisible: inside(heading),
          actionVisible: inside(action),
        };
      });
      const expected = { parent: 'BODY', rect: [0, 0, viewport.width, viewport.height], headingVisible: true, actionVisible: true };
      assert.deepEqual(await geometry(), expected);
      await page.getByRole('button', { name: 'Create step', exact: true }).click();
      await page.getByText('Enter a name for this step.', { exact: true }).waitFor();
      assert.deepEqual(await geometry(), expected);
      assert.equal(await page.getByLabel('Name', { exact: true }).evaluate((input) => input === document.activeElement), true);
    } finally {
      await page.close();
      assert.deepEqual(errors, []);
    }
  });
}
