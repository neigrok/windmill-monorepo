import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { beacon, withBrowserErrors } from '../browserFixture.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const GUIDE = 'One step a week.\nKinds: Learn, Build.\nA step is done on the water.\nAgents: ask first.';
const ELSEWHERE = 'Two steps a week until the June trip.\nAgents: ask first.';
const WORDS = ['week', 'Kinds', 'Learn', 'water', 'Agents', 'June', 'trip', 'Written'];
const entry = `
import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/styles/fonts.js';
import '/src/styles/global.css';
import '/src/products/roadmap/skilltree.css';
import { RoadmapIdentity } from '/src/products/roadmap/identity/RoadmapIdentity.jsx';
import { GuideModal } from '/src/products/roadmap/guide/GuideWide.jsx';
import { GuideEditor, GuideLine, GuideNote } from '/src/products/roadmap/guide/GuidePhone.jsx';
import { useRoomGuide } from '/src/products/roadmap/guide/useGuide.js';
import { SkillTree } from '/src/products/roadmap/model/SkillTree.js';
const root = createRoot(document.getElementById('root'));
window.mount = (options = {}) => {
  window.writes = [];
  function Room() {
    const [text, setText] = useState(options.guide ?? '');
    const tree = useMemo(() => new SkillTree({ id: 'sail', title: 'Learn to sail', guide: text, nodes: [] }), [text]);
    const [sessionRef] = useState(() => ({ current: { treeId: 'sail', setGuide: (next) => {
      window.writes.push(next);
      setText(next);
      return true;
    } } }));
    window.setElsewhere = setText;
    const band = options.band ?? 'desktop';
    const phone = band === 'phone';
    const owner = options.role !== 'reader';
    const who = { owner, reader: !owner, shared: Boolean(options.shared), demo: false, phone };
    const guide = useRoomGuide({ treeId: 'sail', tree, who, deviceLine: options.device ? { text: 'device' } : null, sessionRef });
    const sheet = { current: { id: 'sail', title: 'Learn to sail', done: 3, total: 8, dominantKind: 'sky' },
      listTrees: () => Promise.resolve([]), onPickTree() {}, onNewRoadmap() {}, onBrowse() {} };
    return React.createElement('div', { className: 'st-root' },
      React.createElement('div', { className: 'st-roadmap-identity-host' }, React.createElement(RoadmapIdentity, {
        band, view: 'board', role: owner ? 'owner' : 'reader', title: 'Learn to sail', progress: { done: 3, total: 8 },
        onSwitchView: () => {}, sheet: phone && owner ? sheet : null, guide })),
      phone && guide && !owner && React.createElement('div', { className: 'st-board st-board--phone', style: { position: 'absolute', top: 140, left: 0, right: 0 } },
        React.createElement(GuideLine, { guide })),
      guide?.surface?.kind === 'modal' && !phone && React.createElement(GuideModal, { guide }),
      guide?.surface?.kind === 'note' && phone && React.createElement(GuideNote, { guide }),
      guide?.surface?.kind === 'editor' && phone && React.createElement(GuideEditor, { guide }));
  }
  flushSync(() => root.render(React.createElement(Room)));
};
window.entryReady = true;
`;

let server, origin;
const browsers = new Map();
let ready;
function start() {
  ready ??= (async () => {
    server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-guide-test`,
      plugins: [{ name: 'guide-test', enforce: 'pre',
        resolveId(id) {
          if (id === '/guide-entry.js') return '\0guide-entry';
          if (id.endsWith('/telemetry/beacon.js')) return '\0guide-beacon';
        },
        load(id) {
          if (id === '\0guide-entry') return entry;
          if (id === '\0guide-beacon') return beacon;
        },
        configureServer(vite) {
          vite.middlewares.use('/guide-test', (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Guide test</title><div id="root"></div><script type="module" src="/guide-entry.js"></script>');
          });
        },
      }], optimizeDeps: { include: ['react', 'react-dom/client', 'lucide-react'] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } } });
    await server.listen(0);
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  })();
  return ready;
}
after(async () => {
  for (const browser of browsers.values()) await browser.close();
  await server?.close();
});

async function open(options = {}, { engine = chromium, width = 1440, height = 960 } = {}) {
  await start();
  if (!browsers.has(engine)) browsers.set(engine, await engine.launch({ headless: true }));
  const page = await browsers.get(engine).newPage({ viewport: { width, height } });
  await withBrowserErrors(page, async () => {
    await page.goto(`${origin}/guide-test`);
    await page.waitForFunction(() => window.entryReady);
    await page.evaluate((mounted) => window.mount(mounted), options);
  });
  return page;
}

// The modal opens with wm-pop-in; geometry is read once it stands still.
const settled = (page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
const events = (page) => page.evaluate(() => (window.events ?? []).filter(({ name }) => name === 'roadmap_guide').map(({ props }) => props));
const field = (page) => page.locator('.st-guide-text');
const caretState = (page) => field(page).evaluate((box) => ({ readOnly: box.readOnly, start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box }));

// The point inside a line of the 18/27 field: past its 1.5px edge and 12/16 padding.
async function linePoint(page, line, from = 'start') {
  const box = await field(page).boundingBox();
  const y = box.y + 1.5 + 12 + 27 * line + 13;
  return from === 'start' ? { x: box.x + 1.5 + 16 + 1, y } : { x: box.x + box.width - 24, y };
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: a click on the owner's guide writes from where it landed, and a drag that selects stays reading`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('dialog', { name: 'Guide' }).waitFor();
        await settled(page);
        const from = await linePoint(page, 0, 'start');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 90, from.y, { steps: 4 });
        await page.mouse.up();
        const dragged = await caretState(page);
        assert.equal(dragged.readOnly, true);
        assert.ok(dragged.end > dragged.start, 'the drag selected text');

        const lineStart = await linePoint(page, 2, 'start');
        await page.mouse.click(lineStart.x, lineStart.y);
        assert.deepEqual(await caretState(page), { readOnly: false, start: GUIDE.indexOf('A step'), end: GUIDE.indexOf('A step'), focused: true });
        await page.keyboard.type('Then ');
        assert.equal(await field(page).inputValue(), GUIDE.replace('A step', 'Then A step'));
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'row', role: 'owner' },
          { step: 'edit', via: 'click' },
        ]);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a click past a line's end writes at that line's end`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await settled(page);
        const lineEnd = await linePoint(page, 1, 'end');
        await page.mouse.click(lineEnd.x, lineEnd.y);
        const at = GUIDE.indexOf('\nA step');
        assert.deepEqual(await caretState(page), { readOnly: false, start: at, end: at, focused: true });
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a tap on the phone's Guide page opens the editor with the caret where the finger landed`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone' }, { engine, width: 390, height: 844 });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Learn to sail' }).click();
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        const text = page.locator('.st-guide-page-text');
        await text.waitFor();
        await settled(page);
        assert.equal(await page.locator('.st-guide-reach').textContent(), 'Tap to edit');
        const box = await text.boundingBox();
        await page.mouse.click(box.x + 1, box.y + 22 * 2 + 11);
        await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
        const editor = page.locator('.st-guide-editor-text');
        assert.deepEqual(await editor.evaluate((box) => [box.selectionStart, box.selectionEnd, document.activeElement === box]), [GUIDE.indexOf('A step'), GUIDE.indexOf('A step'), true]);
        assert.equal(await page.locator('.st-guide-editor-bar').textContent(), 'Your agents and anyone you share the tree with read this.Save');
        await page.keyboard.type('Then ');
        await page.locator('.st-guide-editor-bar .st-board-note-save').click();
        await page.getByRole('dialog', { name: 'Edit guide' }).waitFor({ state: 'detached' });
        assert.deepEqual(await page.evaluate(() => window.writes), [GUIDE.replace('A step', 'Then A step')]);
        assert.equal(await text.textContent(), GUIDE.replace('A step', 'Then A step'));
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'sheet', role: 'owner' },
          { step: 'edit', via: 'tap' },
          { step: 'save', outcome: 'saved', length: '1-500' },
        ]);
      });
    } finally { await page.close(); }
  });
}

test('Chromium: the owner reads the guide in a modal that fills the window, and Enter writes from its end', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      const chip = page.getByRole('button', { name: 'Guide: One step a week.' });
      assert.equal(await chip.textContent(), 'One step a week.');
      assert.equal(await chip.getAttribute('aria-haspopup'), 'dialog');
      await chip.click();
      const dialog = page.getByRole('dialog', { name: 'Guide' });
      await dialog.waitFor();
      await settled(page);
      assert.deepEqual(await dialog.boundingBox(), { x: 24, y: 24, width: 1392, height: 912 });
      assert.equal(await page.locator('.st-guide-modal-heading p').textContent(), 'Learn to sail');
      assert.deepEqual(await field(page).evaluate((box) => ({ width: box.getBoundingClientRect().width, value: box.value, readOnly: box.readOnly })), { width: 592, value: GUIDE, readOnly: true });
      assert.equal(await page.locator('.st-guide-modal-footer').textContent(), 'Click to edit');
      await field(page).focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await caretState(page), { readOnly: false, start: GUIDE.length, end: GUIDE.length, focused: true });
      assert.equal(await page.locator('.st-guide-modal-footer').textContent(), 'Your agents and anyone you share the tree with read this.CancelSave');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('[data-guide-opener]'));
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'row', role: 'owner' },
        { step: 'edit', via: 'key' },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: the counter speaks from 4,500 code points, and a paste over 5,000 is kept whole while Save waits', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await field(page).focus();
      await page.keyboard.press('Enter');
      await field(page).fill('🌊'.repeat(4499));
      assert.equal(await page.locator('.st-guide-counter').textContent(), '');
      await field(page).fill('🌊'.repeat(4620));
      assert.equal(await page.locator('.st-guide-counter').textContent(), '380 left');
      await field(page).fill('');
      await page.keyboard.insertText(`${'帆'.repeat(5000)}${'🌊'.repeat(312)}`);
      const over = await field(page).evaluate((box) => ({ points: [...box.value].length, maxLength: box.getAttribute('maxlength'), over: box.classList.contains('st-guide-text--over'), described: box.getAttribute('aria-describedby') === document.querySelector('.st-guide-counter').id }));
      assert.deepEqual(over, { points: 5312, maxLength: null, over: true, described: true });
      assert.equal(await page.locator('.st-guide-counter').textContent(), '312 over');
      const save = page.getByRole('button', { name: 'Save' });
      assert.deepEqual(await save.evaluate((button) => ({ disabled: button.disabled, ariaDisabled: button.getAttribute('aria-disabled'), opacity: getComputedStyle(button).opacity })), { disabled: false, ariaDisabled: 'true', opacity: '0.45' });
      await save.click({ force: true });
      await page.keyboard.press('Meta+Enter');
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await field(page).fill('帆'.repeat(5000));
      assert.equal(await page.locator('.st-guide-counter').textContent(), '0 left');
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('dialog', { name: 'Guide' }).waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.writes.map((written) => [...written].length)), [5000]);
      assert.deepEqual((await events(page)).at(-1), { step: 'save', outcome: 'saved', length: '4501-5000' });
    });
  } finally { await page.close(); }
});

test('Chromium: leaving a changed draft asks first, and an unchanged one closes at once', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await field(page).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Guide' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await field(page).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.type(' Written');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discard draft?' }).waitFor();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(await field(page).inputValue(), `${GUIDE} Written`);
      await page.locator('.st-board-step-scrim').click({ position: { x: 8, y: 8 } });
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('dialog', { name: 'Guide' }).waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      assert.deepEqual((await events(page)).at(-1), { step: 'discard' });
    });
  } finally { await page.close(); }
});

test('Chromium: a guide set elsewhere flashes the chip while reading, and mid-edit offers Load latest', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      const chip = page.getByRole('button', { name: 'Guide: Two steps a week until the June trip.' });
      await chip.waitFor();
      assert.equal(await chip.evaluate((button) => button.classList.contains('st-switcher-flash')), true);
      await page.waitForFunction(() => !document.querySelector('.st-switcher-flash'), null, { timeout: 2000 });
      await chip.click();
      assert.equal(await field(page).inputValue(), ELSEWHERE);
      await field(page).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.type(' Written');
      await page.evaluate((text) => window.setElsewhere(text), GUIDE);
      const strip = page.getByRole('status');
      assert.equal(await strip.textContent(), 'Changed elsewhere. Saving replaces that version.Load latest');
      assert.equal(await field(page).inputValue(), `${ELSEWHERE} Written`);
      await page.getByRole('button', { name: 'Load latest' }).click();
      assert.equal(await field(page).inputValue(), GUIDE);
      assert.equal(await page.getByRole('status').count(), 0);
      assert.deepEqual((await events(page)).at(-1), { step: 'loadLatest' });
    });
  } finally { await page.close(); }
});

test('Chromium: an owner with no guide adds one from a dashed pill, saving nothing leaves none, and clearing removes it', async () => {
  const page = await open({ device: true });
  try {
    await withBrowserErrors(page, async () => {
      const add = page.getByRole('button', { name: 'Add guide' });
      assert.equal(await add.evaluate((button) => getComputedStyle(button).borderTopStyle), 'dashed');
      await add.click();
      await page.getByRole('dialog', { name: 'Guide' }).waitFor();
      assert.deepEqual(await caretState(page), { readOnly: false, start: 0, end: 0, focused: true });
      assert.equal(await field(page).getAttribute('placeholder'), 'What is this tree for, and how should it be worked?');
      assert.equal(await page.locator('.st-guide-disclosure').textContent(), 'Agents can read this once you sign in.');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('dialog', { name: 'Guide' }).waitFor({ state: 'detached' });
      await add.click();
      await page.keyboard.type('Written signed out.');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('button', { name: 'Guide: Written signed out.' }).click();
      await field(page).focus();
      await page.keyboard.press('Enter');
      await field(page).fill('  \n ');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('button', { name: 'Add guide' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes), ['Written signed out.', '']);
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'row', role: 'owner' }, { step: 'edit', via: 'add' }, { step: 'save', outcome: 'unchanged', length: '0' },
        { step: 'open', door: 'row', role: 'owner' }, { step: 'edit', via: 'add' }, { step: 'save', outcome: 'saved', length: '1-500' },
        { step: 'open', door: 'row', role: 'owner' }, { step: 'edit', via: 'key' }, { step: 'save', outcome: 'cleared', length: '0' },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: a reader sees the author\'s note read-only, a reader of a tree with none sees nothing, and the share route shows none', async () => {
  const page = await open({ guide: GUIDE, role: 'reader' });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Author’s note: One step a week.' }).click();
      await page.getByRole('dialog', { name: 'Author’s note' }).waitFor();
      assert.deepEqual(await page.locator('.st-guide-modal-body').evaluate((body) => ({ text: body.querySelector('p').textContent, fields: body.querySelectorAll('textarea').length })), { text: GUIDE, fields: 0 });
      assert.equal(await page.locator('.st-guide-modal-footer').count(), 0);
      await page.locator('.st-guide-text--note').click();
      assert.equal(await page.locator('textarea').count(), 0);
      assert.deepEqual(await events(page), [{ step: 'open', door: 'row', role: 'reader' }]);
      for (const options of [{ guide: '', role: 'reader' }, { guide: GUIDE, role: 'reader', shared: true }, { guide: GUIDE, shared: true }, { guide: '', shared: true }]) {
        await page.evaluate((mounted) => window.mount(mounted), options);
        assert.equal(await page.locator('[data-guide-opener]').count(), 0, JSON.stringify(options));
      }
    });
  } finally { await page.close(); }
});

test('Chromium: from 744 to 1023 the chip is the book alone, and its tooltip names it', async () => {
  const page = await open({ guide: GUIDE, band: 'tablet' }, { width: 900 });
  try {
    await withBrowserErrors(page, async () => {
      const chip = page.getByRole('button', { name: 'Guide: One step a week.' });
      assert.deepEqual(await chip.evaluate((button) => ({ text: button.textContent, width: button.getBoundingClientRect().width })), { text: '', width: 44 });
      await chip.focus();
      assert.equal(await page.getByRole('tooltip').textContent(), 'Guide');
    });
  } finally { await page.close(); }
});

test('Chromium: a phone reader opens the author\'s note from its line, and closing it returns to the line', async () => {
  const page = await open({ guide: GUIDE, role: 'reader', band: 'phone' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      const line = page.getByRole('button', { name: 'Author’s note: One step a week.' });
      assert.equal(await line.textContent(), 'One step a week.');
      await line.click();
      const sheet = page.getByRole('dialog', { name: 'Author’s note' });
      assert.equal(await sheet.locator('.st-guide-sheet-text').textContent(), GUIDE);
      await page.getByRole('button', { name: 'Close' }).click();
      await sheet.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Author’s note: One step a week.');
      assert.deepEqual(await events(page), [{ step: 'open', door: 'line', role: 'reader' }]);
    });
  } finally { await page.close(); }
});

test('Chromium: a phone owner adds a guide from the roadmap sheet in the full-screen editor', async () => {
  const page = await open({ band: 'phone' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Learn to sail' }).click();
      await page.getByRole('button', { name: 'Add guide' }).click();
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      const editor = page.locator('.st-guide-editor-text');
      assert.equal(await editor.getAttribute('placeholder'), 'What is this tree for, and how should it be worked?');
      await page.keyboard.insertText('🌊'.repeat(5312));
      assert.equal(await page.locator('.st-guide-editor-bar .st-guide-counter').textContent(), '312 over');
      await page.locator('.st-guide-editor-bar .st-board-note-save').click({ force: true });
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Add guide' }).click();
      await page.keyboard.type('Written on a phone.');
      await page.locator('.st-guide-editor-bar .st-board-note-save').click();
      await page.getByRole('button', { name: 'Guide: Written on a phone.' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes), ['Written on a phone.']);
      assert.deepEqual((await events(page)).map(({ step }) => step), ['open', 'edit', 'discard', 'open', 'edit', 'save']);
    });
  } finally { await page.close(); }
});

test('Chromium: no guide event carries a word of the guide', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await field(page).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.type(' Written');
      await page.getByRole('button', { name: 'Save' }).click();
      const sent = JSON.stringify(await page.evaluate(() => window.events));
      for (const word of WORDS) assert.equal(sent.includes(word), false, word);
    });
  } finally { await page.close(); }
});
