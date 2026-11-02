import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import { StepDetail } from '/src/products/roadmap/board/StepDetail.jsx';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
import * as workspace from '/src/products/roadmap/model/NodeWorkspace.js';
const noop = () => {};
window.openWorkspace = (initial, history = []) => {
  function App() {
    const [space, setSpace] = useState(initial);
    const actions = {};
    for (const [action, operation] of Object.entries({ onAddSubtask: 'addSubtask', onToggleSubtask: 'toggleSubtask', onDeleteSubtask: 'deleteSubtask', onSetNote: 'setNote', onAddLink: 'addLink', onDeleteLink: 'deleteLink' })) {
      actions[action] = (id, value) => {
        (window.writes ??= []).push({ action, id, value });
        setSpace((current) => workspace[operation](current, value));
      };
    }
    window.space = space;
    window.replaceSpace = setSpace;
    return React.createElement('div', { style: { position: 'fixed', inset: 0 } }, React.createElement(StepDetail, {
      tree: new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [{ id: 'wind', label: 'Read the wind', prerequisites: [] }] }),
      completed: new Set(), completedAt: {}, address: { id: 'wind', trail: ['wind'], door: 'card' },
      breakpoint: innerWidth < 744 ? 'phone' : 'desktop', roadmapTitle: 'Learn to sail', editable: true,
      workspace: space, workspaceActions: actions, history,
      onOpenStep: noop, onBack: () => { window.closed = true; }, onClose: () => { window.closed = true; },
      onComplete: noop, onReset: noop, onRestore: noop, onOpenInGraph: noop, onViewBranch: noop, onEdit: noop,
    }));
  }
  createRoot(document.getElementById('root')).render(React.createElement(App));
};
window.entryReady = true;
`;
let server, browser, origin;
const ready = (async () => {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-step-workspace-test`,
    plugins: [{ name: 'step-workspace-test', enforce: 'pre',
      resolveId(id) {
        if (id === '/workspace-entry.js') return '\0workspace-entry';
        if (id.endsWith('/telemetry/beacon.js')) return '\0workspace-beacon';
      },
      load(id) {
        if (id === '\0workspace-entry') return entry;
        if (id === '\0workspace-beacon') return 'export function track(name, props) { (window.events ??= []).push({name, props}); } export function reportError() {} export function routeFamily(route) { return route; }';
      },
      configureServer(server) {
        server.middlewares.use('/workspace-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/workspace-entry.js"></script>');
        });
      },
    }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
  await server.listen(0);
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
})();
after(async () => { try { await ready; } finally { await browser?.close(); await server?.close(); } });
const initial = { subtasks: [{ id: 'turn', label: 'Try a small turn', done: false }], note: 'Watch the telltales.\n\nEase the sail.', links: [{ id: 'guide', url: 'https://example.com', title: 'Wind guide', domain: 'example.com' }] };
async function open(width, space = initial, history = []) {
  await ready;
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.clock.install({ time: new Date('2026-11-03T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-03T12:00:01Z'));
  await page.goto(`${origin}/workspace-test`);
  await page.waitForFunction(() => window.entryReady);
  await page.evaluate(({ space, history }) => window.openWorkspace(space, history), { space, history });
  await page.getByRole('tab', { name: 'Workspace', exact: true }).click();
  return page;
}

for (const width of [390, 1024]) {
  test(`workspace ${width}: note draft Save once and focus returns to Edit`, async () => {
    const page = await open(width);
    try {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Note', exact: true });
      await editor.fill('A new note');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.clock.runFor(20);
      await page.waitForFunction(() => document.activeElement?.textContent === 'Edit');
      assert.deepEqual(await page.evaluate(() => window.writes), [{ action: 'onSetNote', id: 'wind', value: 'A new note' }]);
      assert.equal(await page.locator('.st-board-workspace-note').textContent(), 'A new note');
      assert.equal(await page.evaluate(() => window.closed ?? false), false);
    } finally { await page.close(); }
  });

  test(`workspace ${width}: untouched rich notes survive selection and Save exactly`, async () => {
    const note = 'First **bold** and *italic*.\n\n- a\n- b\n\n[Guide](https://example.com) \uE000\uE001';
    const page = await open(width, { ...initial, note });
    try {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('textbox', { name: 'Note', exact: true }).evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.clock.runFor(20);
      assert.deepEqual(await page.evaluate(() => window.writes), [{ action: 'onSetNote', id: 'wind', value: note }]);
    } finally { await page.close(); }
  });

  test(`workspace ${width}: changed Cancel asks once, Escape keeps editing, Discard writes nothing`, async () => {
    const page = await open(width);
    try {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Changed');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('dialog', { name: 'Discard draft?' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discard draft?' }).waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.closed ?? false), false);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.locator('.st-board-workspace-note').waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes ?? []), []);
      assert.deepEqual(await page.evaluate(() => window.events.filter((event) => event.name === 'roadmap_board_workspace')), [{ name: 'roadmap_board_workspace', props: { action: 'noteDiscard' } }]);
    } finally { await page.close(); }
  });

  test(`workspace ${width}: personal link Text survives Apply and focus returns`, async () => {
    const page = await open(width);
    try {
      await page.getByRole('button', { name: '+ Add link', exact: true }).click();
      await page.getByLabel('Text', { exact: true }).fill('My guide');
      await page.getByLabel('URL', { exact: true }).fill('javascript:alert(1)');
      assert.equal(await page.getByRole('button', { name: 'Apply' }).isDisabled(), true);
      await page.getByLabel('URL', { exact: true }).fill('https://www.example.org/guide');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.clock.runFor(20);
      await page.getByRole('link', { name: 'My guide' }).waitFor();
      await page.waitForFunction(() => document.activeElement?.hasAttribute('data-add-link'));
      assert.deepEqual(await page.evaluate(() => window.writes), [{ action: 'onAddLink', id: 'wind', value: { title: 'My guide', url: 'https://www.example.org/guide' } }]);
    } finally { await page.close(); }
  });
}

test('phone checklist toast stays in the page, Undo toggles back, expiry is six seconds', async () => {
  const page = await open(390);
  try {
    await page.getByRole('checkbox', { name: 'Try a small turn' }).check();
    await page.locator('.st-board-step-checked').waitFor();
    assert.equal(await page.locator('.st-board-step-checked [role=status]').textContent(), 'Try a small turn checked');
    await page.locator('.st-board-step-checked').getByRole('button', { name: 'Undo' }).click();
    assert.equal(await page.getByRole('checkbox').isChecked(), false);
    await page.getByRole('checkbox').check();
    await page.clock.runFor(5999);
    assert.equal(await page.locator('.st-board-step-checked').count(), 1);
    await page.clock.runFor(1);
    await page.locator('.st-board-step-checked').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.writes.map((write) => write.action)), ['onToggleSubtask', 'onToggleSubtask', 'onToggleSubtask']);
  } finally { await page.close(); }
});

test('desktop never shows checked toast; deleted task cannot be undone', async () => {
  const page = await open(1024);
  try {
    await page.getByRole('checkbox').check();
    assert.equal(await page.locator('.st-board-step-checked').count(), 0);
    await page.getByRole('button', { name: 'Remove subtask' }).click();
    assert.equal(await page.getByRole('checkbox').count(), 0);
  } finally { await page.close(); }
});

test('empty and partial workspaces only offer missing types; History groups use shared day labels', async () => {
  const page = await open(390, { subtasks: [], note: '', links: [] }, [
    { id: 'today', nodeId: 'wind', actor: 'You', verb: 'renamed', label: 'Read the wind', at: Date.parse('2026-11-03T11:00:00Z') },
    { id: 'yesterday', nodeId: 'wind', actor: 'You', verb: 'added', label: 'Read the wind', at: Date.parse('2026-11-02T12:00:00Z') },
  ]);
  try {
    assert.equal(await page.getByText('Add something for this step.').count(), 1);
    assert.deepEqual(await page.locator('.st-board-workspace-missing button').allTextContents(), ['+ Add subtask', '+ Add note', '+ Add link']);
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    assert.deepEqual(await page.locator('.st-board-workspace-day').allTextContents(), ['Today', 'Yesterday']);
    assert.deepEqual(await page.locator('.st-board-workspace-event time').allTextContents(), ['1h', '1d']);
    assert.deepEqual(await page.locator('.st-board-workspace-event .st-event-obj').evaluateAll((labels) => labels.map((label) => ({
      text: label.textContent,
      decoration: getComputedStyle(label).textDecorationLine,
      matchesRowColor: getComputedStyle(label).color === getComputedStyle(label.closest('.st-board-workspace-event')).color,
      kindDots: label.querySelectorAll('i').length,
    }))), [
      { text: 'Read the wind', decoration: 'none', matchesRowColor: true, kindDots: 0 },
      { text: 'Read the wind', decoration: 'none', matchesRowColor: true, kindDots: 0 },
    ]);
  } finally { await page.close(); }
});

test('note formatting and link sheet edit only the draft, with Escape confined to the sheet', async () => {
  const page = await open(390, { ...initial, note: 'Watch wind' });
  try {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const writing = page.getByRole('textbox', { name: 'Note', exact: true });
    const select = async (start, end) => writing.evaluate((element, offsets) => {
      const node = element.querySelector('p')?.firstChild ?? element.firstChild;
      const range = document.createRange();
      range.setStart(node, offsets.start);
      range.setEnd(node, offsets.end);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { start, end });
    await select(0, 5);
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    assert.equal(await writing.locator('strong').textContent(), 'Watch');
    assert.deepEqual(await page.evaluate(() => window.writes ?? []), []);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.clock.runFor(20);
    assert.equal(await page.evaluate(() => window.space.note), '**Watch** wind');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await writing.fill('Watch wind');
    await select(6, 10);
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    assert.equal(await page.getByLabel('Text', { exact: true }).inputValue(), 'wind');
    await page.keyboard.press('Escape');
    await page.getByLabel('URL', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.closed ?? false), false);
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.getByLabel('URL', { exact: true }).fill('https://example.org');
    await page.getByRole('button', { name: 'Apply' }).click();
      await page.clock.runFor(20);
    assert.equal(await writing.locator('a').getAttribute('href'), 'https://example.org');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.clock.runFor(20);
    assert.equal(await page.evaluate(() => window.space.note), 'Watch [wind](https://example.org)');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await writing.fill('one\ntwo');
    await writing.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.getByRole('button', { name: 'List', exact: true }).click();
    assert.deepEqual(await writing.locator('li').allTextContents(), ['one', 'two']);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.clock.runFor(20);
    assert.equal(await page.evaluate(() => window.space.note), '- one\n- two');
  } finally { await page.close(); }
});

test('phone Add note saves to the pinned Edit note opener and empty History is explicit', async () => {
  const page = await open(390, { subtasks: [], note: '', links: [] });
  try {
    await page.locator('.st-board-step-page-pinned').getByRole('button', { name: 'Add note', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note', exact: true }).fill('First note');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.clock.runFor(20);
    await page.waitForFunction(() => document.activeElement?.textContent === 'Edit note' && Boolean(document.activeElement.closest('.st-board-step-page-pinned')));
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    assert.equal(await page.locator('.st-board-workspace-empty-history').textContent(), 'No changes yet');
  } finally { await page.close(); }
});
