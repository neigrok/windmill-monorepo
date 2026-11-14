import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { withBrowserErrors } from '../browserFixture.js';
import {
  ELSEWHERE, GUIDE, WORDS, caretState, events, field, focusedName, hostGuideSurfaces, issues, open, origin, prose,
  settled, stepInert,
} from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-test' });

// The crossfade a guide set elsewhere earns is the one animation on the prose that no stylesheet declares.
const arrivalFades = (page) => page.evaluate(() => document.querySelector('.st-guide-prose').getAnimations().filter((animation) => !(animation instanceof CSSAnimation)).length);

// A point inside a line of the prose: `height` is its line height, 32px from 744px and 25px on phones.
async function linePoint(page, line, from = 'start', height = 32) {
  const box = await prose(page).boundingBox();
  const y = box.y + height * line + height / 2;
  return from === 'start' ? { x: box.x + 1, y } : { x: box.x + box.width - 8, y };
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: the card opens the note in place beside a live tree, a drag that selects stays reading, and a click writes from where it landed`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        const card = page.getByRole('button', { name: 'Guide: One step a week.' });
        assert.equal(await card.textContent(), 'GuideOne step a week.Read guide→');
        const resting = await card.boundingBox();
        await card.click();
        const note = page.getByRole('dialog', { name: 'Guide', exact: true });
        await note.waitFor();
        await settled(page);
        const opened = await note.boundingBox();
        assert.deepEqual({
          modal: await note.getAttribute('aria-modal'),
          tree: await stepInert(page),
          cardShown: await page.locator('.st-guide-card').evaluate((button) => getComputedStyle(button).visibility),
          width: opened.width,
          focus: await focusedName(page),
        }, { modal: null, tree: false, cardShown: 'hidden', width: 642, focus: 'st-guide-prose st-guide-prose--owner' });
        assert.ok(Math.abs(opened.x - resting.x + 4) <= 0.25, `note left offset: ${opened.x - resting.x}px`);
        assert.ok(Math.abs(opened.y - resting.y + 16) <= 0.25, `note top offset: ${opened.y - resting.y}px`);

        const from = await linePoint(page, 0, 'start');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 120, from.y, { steps: 4 });
        await page.mouse.up();
        assert.equal(await field(page).count(), 0, 'the drag selected text and stayed reading');

        const lineStart = await linePoint(page, 2, 'start');
        await page.mouse.click(lineStart.x, lineStart.y);
        await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
        assert.deepEqual(await caretState(page), { start: GUIDE.indexOf('A step'), end: GUIDE.indexOf('A step'), focused: true });
        assert.equal(await stepInert(page), true);
        const writing = await page.getByRole('dialog', { name: 'Edit guide' }).boundingBox();
        assert.deepEqual([writing.x, writing.y], [opened.x, opened.y]);
        await page.keyboard.type('Then ');
        assert.equal(await field(page).inputValue(), GUIDE.replace('A step', 'Then A step'));
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' },
          { step: 'edit', via: 'click' },
        ]);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a held card press opens the note at the card's resting position`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        const card = page.getByRole('button', { name: 'Guide: One step a week.' });
        await card.hover();
        await settled(page);
        const resting = await card.boundingBox();
        await page.mouse.down();
        await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector('.st-guide-card')).transform).a < 0.98);
        await page.mouse.up();
        const note = page.getByRole('dialog', { name: 'Guide', exact: true });
        await note.waitFor();
        await settled(page);
        const opened = await note.boundingBox();
        assert.ok(Math.abs(opened.x - resting.x + 4) <= 0.25, `note left offset: ${opened.x - resting.x}px`);
        assert.ok(Math.abs(opened.y - resting.y + 16) <= 0.25, `note top offset: ${opened.y - resting.y}px`);
        assert.equal(await focusedName(page), 'st-guide-prose st-guide-prose--owner');
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
        assert.deepEqual(await caretState(page), { start: at, end: at, focused: true });
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a tap on the phone sheet's text writes in the same sheet with the caret where the finger landed`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone' }, { engine, width: 390, height: 844 });
    try {
      await withBrowserErrors(page, async () => {
        const row = page.getByRole('button', { name: 'Guide: One step a week.' });
        assert.equal(await row.textContent(), `Guide${GUIDE}`);
        await row.click();
        const sheet = page.getByRole('dialog', { name: 'Guide', exact: true });
        await sheet.waitFor();
        await settled(page);
        assert.deepEqual({
          modal: await sheet.getAttribute('aria-modal'),
          tree: await stepInert(page),
          foot: await sheet.evaluate((element) => window.innerHeight - element.getBoundingClientRect().bottom),
        }, { modal: 'true', tree: true, foot: 0 });
        const point = await linePoint(page, 2, 'start', 25);
        await page.mouse.click(point.x, point.y);
        await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
        assert.deepEqual(await caretState(page), { start: GUIDE.indexOf('A step'), end: GUIDE.indexOf('A step'), focused: true });
        assert.equal(await page.locator('.st-guide-footer').textContent(), 'Visible to your agents and people you share with.CancelSave');
        await page.keyboard.type('Then ');
        await page.getByRole('button', { name: 'Save' }).click();
        await sheet.waitFor();
        assert.deepEqual(await page.evaluate(() => window.writes), [GUIDE.replace('A step', 'Then A step')]);
        assert.equal(await prose(page).textContent(), GUIDE.replace('A step', 'Then A step'));
        assert.equal(await focusedName(page), 'st-guide-prose st-guide-prose--owner');
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' },
          { step: 'edit', via: 'tap' },
          { step: 'save', outcome: 'saved', length: '1-500' },
        ]);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a reader's long author's note takes focus on its text and scrolls with PageDown, the arrows and Space`, async () => {
    const note = Array.from({ length: 80 }, (_, line) => `Line ${line + 1} of the author's note.`).join('\n');
    const page = await open({ guide: note, role: 'reader' }, { engine, width: 1024, height: 700 });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Author’s note: Line 1 of the author\'s note.' }).click();
        const dialog = page.getByRole('dialog', { name: 'Author’s note' });
        await dialog.waitFor();
        await settled(page);
        const body = page.getByRole('region', { name: 'Author’s note' });
        assert.deepEqual({
          focus: await focusedName(page),
          pencil: await page.getByRole('button', { name: 'Edit guide' }).count(),
          inWindow: await dialog.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight - 24),
          scrolls: await body.evaluate((element) => element.scrollHeight > element.clientHeight),
        }, { focus: 'st-guide-prose', pencil: 0, inWindow: true, scrolls: true });
        const scrolled = [];
        for (const key of ['PageDown', 'ArrowDown', 'Space']) {
          const before = await body.evaluate((element) => element.scrollTop);
          await page.keyboard.press(key);
          await page.waitForFunction((top) => document.querySelector('.st-guide-prose').scrollTop > top, before);
          scrolled.push(key);
        }
        assert.deepEqual(scrolled, ['PageDown', 'ArrowDown', 'Space']);
        await body.click();
        assert.equal(await field(page).count(), 0, 'a reader cannot write');
      });
    } finally { await page.close(); }
  });
}

test('Chromium: the pencil writes from the end, Save waits for a change, and the saved note is read before it closes back to its card', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      const card = page.getByRole('button', { name: 'Guide: One step a week.' });
      await card.click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.getByRole('dialog', { name: 'Edit guide' }).waitFor();
      assert.deepEqual(await caretState(page), { start: GUIDE.length, end: GUIDE.length, focused: true });
      assert.equal(await page.locator('.st-guide-footer').textContent(), 'Your agents and people you share this tree with can read the guide.CancelSave');
      const save = page.getByRole('button', { name: 'Save' });
      assert.deepEqual(await save.evaluate((button) => [button.getAttribute('aria-disabled'), getComputedStyle(button).opacity]), ['true', '0.45']);
      await save.click({ force: true });
      await page.keyboard.press('Meta+Enter');
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await field(page).focus();
      await page.keyboard.type('\nWritten on the dock.');
      assert.equal(await save.getAttribute('aria-disabled'), null);
      await save.click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes), [`${GUIDE}\nWritten on the dock.`]);
      assert.equal(await prose(page).textContent(), `${GUIDE}\nWritten on the dock.`);
      assert.equal(await stepInert(page), false);
      await page.getByRole('button', { name: 'Close' }).click();
      await note.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-card'));
      assert.equal(await card.evaluate((button) => getComputedStyle(button).visibility), 'visible');
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' },
        { step: 'edit', via: 'pencil' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: the counter speaks from 4,500 code points beside the audience line, and a paste over 5,000 is kept whole while Save waits', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await prose(page).press('Enter');
      const count = page.locator('.st-guide-count');
      await field(page).fill('🌊'.repeat(4499));
      assert.equal(await count.textContent(), '');
      await field(page).fill('🌊'.repeat(4620));
      assert.equal(await page.locator('.st-guide-footer').textContent(), 'Your agents and people you share this tree with can read the guide.380 leftCancelSave');
      await field(page).fill('');
      await page.keyboard.insertText(`${'帆'.repeat(5000)}${'🌊'.repeat(312)}`);
      assert.deepEqual(await field(page).evaluate((box) => ({
        points: [...box.value].length,
        maxLength: box.getAttribute('maxlength'),
        over: box.classList.contains('st-guide-field--over'),
        described: box.getAttribute('aria-describedby') === document.querySelector('.st-guide-count').id,
        inPaper: box.getBoundingClientRect().bottom < box.closest('.st-guide-paper').getBoundingClientRect().bottom,
        scrolls: box.scrollHeight > box.clientHeight,
      })), { points: 5312, maxLength: null, over: true, described: true, inPaper: true, scrolls: true });
      assert.equal(await count.textContent(), '312 over');
      const save = page.getByRole('button', { name: 'Save' });
      assert.deepEqual(await save.evaluate((button) => [button.disabled, button.getAttribute('aria-disabled')]), [false, 'true']);
      await save.click({ force: true });
      await page.keyboard.press('Meta+Enter');
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await field(page).fill('帆'.repeat(5000));
      assert.equal(await count.textContent(), '0 left');
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.writes.map((written) => [...written].length)), [5000]);
      assert.deepEqual((await events(page)).at(-1), { step: 'save', outcome: 'saved', length: '4501-5000' });
    });
  } finally { await page.close(); }
});

test('Chromium: Cancel on an unchanged draft returns to the note at once, and leaving a changed one asks over the note', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await prose(page).press('Enter');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.equal(await focusedName(page), 'st-guide-prose st-guide-prose--owner');
      await page.keyboard.press('Enter');
      await page.keyboard.type(' Written');
      await page.keyboard.press('Escape');
      const question = page.getByRole('alertdialog', { name: 'Discard draft?' });
      await question.waitFor();
      assert.equal(await question.textContent(), 'Discard draft?Your changes will be lost.Keep editingDiscard');
      const [asked, paper] = [await question.boundingBox(), await page.locator('.st-guide-paper').boundingBox()];
      assert.deepEqual({
        width: asked.width,
        centred: Math.abs(asked.x + asked.width / 2 - (paper.x + paper.width / 2)) < 1,
        over: asked.y > paper.y && asked.y + asked.height < paper.y + paper.height,
        draftHeld: await page.locator('.st-guide-paper').evaluate((element) => element.inert),
      }, { width: 470, centred: true, over: true, draftHeld: true });
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(await field(page).inputValue(), `${GUIDE} Written`);
      assert.equal((await caretState(page)).focused, true);
      await page.mouse.click(1200, 600);
      await question.waitFor();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.equal(await prose(page).textContent(), GUIDE);
      assert.equal(await stepInert(page), false);
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      assert.deepEqual((await events(page)).at(-1), { step: 'discard' });
    });
  } finally { await page.close(); }
});

test('Chromium: a guide set elsewhere replaces the card\'s line and the note\'s text, and mid-edit a status line offers Load latest', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      const card = page.getByRole('button', { name: 'Guide: Two steps a week until the June trip.' });
      await card.click();
      assert.equal(await prose(page).textContent(), ELSEWHERE);
      await page.evaluate((text) => window.setElsewhere(text), GUIDE);
      await page.waitForFunction((text) => document.querySelector('.st-guide-prose').textContent === text, GUIDE);
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      await prose(page).press('Enter');
      await page.keyboard.type(' Written');
      await page.evaluate((text) => window.setElsewhere(text), GUIDE);
      const status = page.getByRole('status');
      assert.equal(await status.textContent(), 'Changed elsewhere. Saving replaces that version.Load latest');
      assert.equal(await status.evaluate((line) => line.parentElement.className), 'st-guide-footer');
      assert.equal(await field(page).inputValue(), `${ELSEWHERE} Written`);
      await page.getByRole('button', { name: 'Load latest' }).click();
      assert.equal(await field(page).inputValue(), GUIDE);
      assert.equal(await page.getByRole('status').count(), 0);
      assert.deepEqual((await events(page)).at(-1), { step: 'loadLatest' });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
    });
  } finally { await page.close(); }
});

test('Chromium: an owner with no guide adds one from the card, an untouched Add guide closes at once, and clearing a guide removes it', async () => {
  const page = await open({});
  try {
    await withBrowserErrors(page, async () => {
      const add = page.getByRole('button', { name: 'Add guide', exact: true });
      assert.equal(await add.textContent(), 'Add guide→');
      await add.click();
      const adding = page.getByRole('dialog', { name: 'Add guide' });
      await adding.waitFor();
      assert.deepEqual(await field(page).evaluate((box) => [box.placeholder, box.value, document.activeElement === box]), ['What are you working toward?', '', true]);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await adding.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-card[aria-label="Add guide"]'));
      await add.click();
      await page.keyboard.type('  \n ');
      await page.keyboard.press('Meta+Enter');
      assert.equal(await page.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Escape');
      await adding.waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await add.click();
      await page.keyboard.type('Written on the dock.');
      await page.getByRole('button', { name: 'Save' }).click();
      await adding.waitFor({ state: 'detached' });
      const card = page.getByRole('button', { name: 'Guide: Written on the dock.' });
      await card.waitFor();
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-card[aria-label^="Guide:"]'));
      assert.deepEqual(await page.evaluate(() => window.writes), ['Written on the dock.']);
      await card.click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('');
      await page.getByRole('button', { name: 'Save' }).click();
      await add.waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.writes), ['Written on the dock.', '']);
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'add' },
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'add' },
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'add' },
        { step: 'save', outcome: 'saved', length: '1-500' },
        { step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'pencil' },
        { step: 'save', outcome: 'cleared', length: '0' },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: a reader sees the author\'s note on the tree, a reader of a tree with none sees nothing, and the share route shows none', async () => {
  const reader = await open({ guide: GUIDE, role: 'reader' });
  try {
    await withBrowserErrors(reader, async () => {
      const card = reader.getByRole('button', { name: 'Author’s note: One step a week.' });
      assert.equal(await card.textContent(), 'Author’s noteOne step a week.Read note→');
      await card.click();
      await reader.getByRole('dialog', { name: 'Author’s note' }).waitFor();
      assert.equal(await prose(reader).textContent(), GUIDE);
      assert.deepEqual(await events(reader), [{ step: 'open', door: 'card', view: 'graph', role: 'reader', above: 'none' }]);
      await reader.evaluate(() => window.setElsewhere(''));
      await reader.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await reader.locator('.st-guide-card').count(), 0);
    });
  } finally { await reader.close(); }
  for (const options of [{ role: 'reader' }, { guide: GUIDE, role: 'reader', shared: true }, { guide: GUIDE, role: 'reader', shared: true, band: 'phone' }]) {
    const page = await open(options);
    try {
      assert.equal(await page.locator('.st-guide-card, .st-guide-row').count(), 0);
    } finally { await page.close(); }
  }
});

test('Chromium: on a phone Cancel leaves a clean edit for the sheet it began in, a changed one asks from the foot, and the count takes the audience line', async () => {
  const page = await open({ guide: GUIDE, band: 'phone', device: true }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      const row = page.getByRole('button', { name: 'Guide: One step a week.' });
      await row.click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit guide' });
      await editor.waitFor();
      assert.equal(await page.locator('.st-guide-footer').textContent(), 'Only on this device until you sign in.CancelSave');
      const save = page.getByRole('button', { name: 'Save' });
      assert.deepEqual(await save.evaluate((button) => [button.getAttribute('aria-disabled'), getComputedStyle(button).opacity]), ['true', '0.45']);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill(`${'帆'.repeat(5000)}${'🌊'.repeat(312)}`);
      assert.equal(await page.locator('.st-guide-footer').textContent(), '312 overCancelSave');
      assert.deepEqual(await editor.evaluate((sheet) => {
        const box = sheet.getBoundingClientRect();
        const footer = sheet.querySelector('.st-guide-footer').getBoundingClientRect();
        return { foot: window.innerHeight - box.bottom, footerAtFoot: box.bottom - footer.bottom, belowHead: box.top > 100 };
      }), { foot: 0, footerAtFoot: 0, belowHead: true });
      await page.locator('.st-guide-backdrop').click({ position: { x: 20, y: 20 } });
      const question = page.getByRole('alertdialog', { name: 'Discard draft?' });
      await question.waitFor();
      assert.deepEqual(await question.evaluate((sheet) => {
        const box = sheet.getBoundingClientRect();
        return [box.left, box.width, window.innerHeight - box.bottom];
      }), [0, 390, 0]);
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.equal(await prose(page).textContent(), GUIDE);
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-row'));
      assert.deepEqual(await page.evaluate(() => window.writes), []);
    });
  } finally { await page.close(); }
});

test('Chromium: a phone owner with no guide adds the first from the Add guide row, and the saved row takes focus in place', async () => {
  const page = await open({ band: 'phone', device: true }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      const add = page.getByRole('button', { name: 'Add guide', exact: true });
      const empty = await add.boundingBox();
      assert.deepEqual([empty.x, empty.y, empty.width, empty.height], [16, 114, 358, 52]);
      await add.click();
      const adding = page.getByRole('dialog', { name: 'Add guide' });
      await adding.waitFor();
      assert.deepEqual(await field(page).evaluate((box) => [box.placeholder, document.activeElement === box]), ['What are you working toward?', true]);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await adding.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-row'));
      await add.click();
      await page.keyboard.type('Maya and I take the dinghy out on Sundays.');
      await page.getByRole('button', { name: 'Save' }).click();
      await adding.waitFor({ state: 'detached' });
      const row = page.getByRole('button', { name: 'Guide: Maya and I take the dinghy out on Sundays.' });
      await row.waitFor();
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-row'));
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.writes), ['Maya and I take the dinghy out on Sundays.']);
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'add' },
        { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'add' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ]);
    });
  } finally { await page.close(); }
});

test('Chromium: a phone reader opens the author\'s note from its row, a note set elsewhere crossfades in once, and closing returns to the row', async () => {
  const page = await open({ guide: GUIDE, band: 'phone', role: 'reader' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      const row = page.getByRole('button', { name: 'Author’s note: One step a week.' });
      const box = await row.boundingBox();
      assert.deepEqual([box.x, box.y, box.width], [16, 114, 358]);
      await row.click();
      const sheet = page.getByRole('dialog', { name: 'Author’s note' });
      await sheet.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Edit guide' }).count(), 0);
      assert.equal(await arrivalFades(page), 0, 'opening the note is not an arrival');
      await settled(page);
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      await page.waitForFunction((text) => document.querySelector('.st-guide-prose').textContent === text, ELSEWHERE);
      assert.deepEqual(await page.evaluate(() => [document.querySelector('.st-guide-prose'), document.querySelector('.st-guide-row-excerpt')]
        .map((shown) => shown.getAnimations().filter((animation) => !(animation instanceof CSSAnimation)).length)), [1, 1]);
      await settled(page);
      assert.equal(await arrivalFades(page), 0, 'the crossfade played once');
      await prose(page).click();
      assert.equal(await field(page).count(), 0);
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-row'));
      assert.deepEqual(await events(page), [{ step: 'open', door: 'row', view: 'graph', role: 'reader', above: 'none' }]);
    });
  } finally { await page.close(); }
});

test('Chromium: under reduced motion a note set elsewhere is replaced at once', async () => {
  const page = await open({ guide: GUIDE, band: 'phone', role: 'reader' }, { width: 390, height: 844, reducedMotion: 'reduce' });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Author’s note: One step a week.' }).click();
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      await page.waitForFunction((text) => document.querySelector('.st-guide-prose').textContent === text, ELSEWHERE);
      assert.deepEqual(await page.evaluate(() => [document.querySelector('.st-guide-prose'), document.querySelector('.st-guide-row-excerpt'), document.querySelector('.st-guide-paper')]
        .map((shown) => shown.getAnimations().length)), [0, 0, 0]);
    });
  } finally { await page.close(); }
});

test('Chromium: no guide event carries a word of the guide', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await prose(page).press('Enter');
      await page.keyboard.type(' Written');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      const sent = JSON.stringify(await page.evaluate(() => window.events));
      for (const word of WORDS) assert.equal(sent.includes(word), false, word);
    });
  } finally { await page.close(); }
});

test('Chromium: the note stays open with its draft when the window crosses 744px, and closes with a discard when the guide stops being shown', async () => {
  const page = await open({ guide: GUIDE }, { width: 1024, height: 800 });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.setRoom({ band: 'phone' }));
      await page.locator('.st-guide-paper--phone').waitFor();
      const sheet = page.getByRole('dialog', { name: 'Edit guide' });
      assert.deepEqual({ draft: await field(page).inputValue(), phone: await sheet.evaluate((paper) => paper.classList.contains('st-guide-paper--phone')), foot: await sheet.evaluate((paper) => window.innerHeight - paper.getBoundingClientRect().bottom) },
        { draft: `${GUIDE} Written`, phone: true, foot: 0 });
      await page.setViewportSize({ width: 1024, height: 800 });
      await page.evaluate(() => window.setRoom({ band: 'desktop' }));
      assert.equal(await field(page).inputValue(), `${GUIDE} Written`);
      assert.deepEqual(await events(page), [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }, { step: 'edit', via: 'pencil' }]);

      await page.evaluate(() => window.setRoom({ shared: true }));
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await page.evaluate(() => window.setRoom({ shared: false }));
      await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual((await events(page)).slice(2), [{ step: 'discard' }]);
    });
  } finally { await page.close(); }
});

test('Chromium: a save in flight holds the frame: the field is read-only, Save is busy, and nothing leaves until it settles', async () => {
  const page = await open({ guide: GUIDE, door: 'server' });
  try {
    await withBrowserErrors(page, async () => {
      const sent = [];
      let settle;
      const gate = new Promise((resolve) => { settle = resolve; });
      await page.route('**/v1/trees/**', async (route) => {
        if (route.request().method() === 'PATCH') sent.push(JSON.parse(route.request().postData()).guide);
        await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' }, body: '{}' });
      });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' FIRST');
      await page.keyboard.press('Meta+Enter');
      await page.waitForFunction(() => document.querySelector('.st-guide-field').readOnly);
      await page.keyboard.type(' SECOND');
      await page.keyboard.press('Escape');
      await page.mouse.click(1200, 600);
      await page.getByRole('button', { name: 'Cancel' }).click();
      assert.deepEqual({
        field: await field(page).inputValue(),
        busy: await page.getByRole('button', { name: 'Save' }).getAttribute('aria-busy'),
        asked: await page.getByRole('alertdialog').count(),
      }, { field: `${GUIDE} FIRST`, busy: 'true', asked: 0 });
      settle();
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual(sent, [`${GUIDE} FIRST`]);
      assert.deepEqual((await events(page)).slice(2), [{ step: 'save', outcome: 'saved', length: '1-500' }]);
    });
  } finally { await page.close(); }
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: while writing and while Discard draft? shows, Tab stays inside and Escape and ⌘↩ work wherever focus stands`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        await page.keyboard.type(' Written');
        const stops = [];
        for (let press = 0; press < 4; press += 1) {
          await page.keyboard.press('Tab');
          stops.push(await page.evaluate(() => (document.activeElement.tagName === 'TEXTAREA' ? 'TEXTAREA' : document.activeElement.textContent)));
        }
        assert.deepEqual(stops, ['Cancel', 'Save', 'TEXTAREA', 'Cancel']);
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('Escape');
        const question = page.getByRole('alertdialog', { name: 'Discard draft?' });
        await question.waitFor();
        assert.equal(await question.evaluate((dialog) => document.getElementById(dialog.getAttribute('aria-describedby')).textContent), 'Your changes will be lost.');
        const asked = [];
        for (let press = 0; press < 3; press += 1) {
          await page.keyboard.press('Tab');
          asked.push(await page.evaluate(() => document.activeElement.textContent));
        }
        assert.deepEqual(asked, ['Keep editing', 'Discard', 'Keep editing']);
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press('Escape');
        await question.waitFor({ state: 'detached' });
        await page.keyboard.press('Tab');
        await page.keyboard.press('Meta+Enter');
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.writes), [`${GUIDE} Written`]);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a pointer opens the note with no focus ring on its prose, and a key opens it with one`, async () => {
    const page = await open({ guide: GUIDE }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        const ring = () => prose(page).evaluate((shown) => [document.activeElement === shown, getComputedStyle(shown).outlineStyle, shown.getAttribute('role'), shown.getAttribute('aria-readonly')]);
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await ring(), [true, 'none', 'textbox', 'true']);
        await page.getByRole('button', { name: 'Close' }).click();
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        await page.locator('.st-guide-card').focus();
        await page.keyboard.press('Enter');
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await ring(), [true, 'solid', 'textbox', 'true']);
      });
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a guide stored with CRLF takes the caret where the press landed and is unchanged until it differs`, async () => {
    const page = await open({ guide: GUIDE.replaceAll('\n', '\r\n') }, { engine });
    try {
      await withBrowserErrors(page, async () => {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await settled(page);
        const lineStart = await linePoint(page, 2, 'start');
        await page.mouse.click(lineStart.x, lineStart.y);
        assert.deepEqual(await caretState(page), { start: GUIDE.indexOf('A step'), end: GUIDE.indexOf('A step'), focused: true });
        await page.keyboard.type('x');
        await page.keyboard.press('Backspace');
        assert.equal(await page.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled'), 'true');
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.equal(await page.getByRole('alertdialog').count(), 0);
      });
    } finally { await page.close(); }
  });
}

test('Chromium: Enter held on the entry opens the note once: it neither runs on into writing nor types into a new guide', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.locator('.st-guide-card').focus();
      for (let press = 0; press < 4; press += 1) await page.keyboard.down('Enter');
      await page.keyboard.up('Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.equal(await field(page).count(), 0);
      assert.deepEqual(await events(page), [{ step: 'open', door: 'card', view: 'graph', role: 'owner', above: 'none' }]);
    });
  } finally { await page.close(); }
  const empty = await open({});
  try {
    await withBrowserErrors(empty, async () => {
      await empty.locator('.st-guide-card').focus();
      for (let press = 0; press < 4; press += 1) await empty.keyboard.down('Enter');
      await empty.keyboard.up('Enter');
      assert.equal(await field(empty).inputValue(), '');
      await empty.keyboard.press('Enter');
      assert.equal(await field(empty).inputValue(), '\n');
    });
  } finally { await empty.close(); }
});

test('Chromium: an owner demoted mid-draft saves nothing and is told it was refused; a clipboard that refuses the copy leaves Copy draft standing, and Cancel still asks', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Fixture clipboard refusal', 'NotAllowedError'); },
      } }));
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await page.keyboard.type(' Written');
      await page.evaluate(() => window.setRoom({ owner: false }));
      await page.waitForFunction(() => document.querySelector('.st-guide-card').getAttribute('aria-label').startsWith('Author’s note'));
      await page.keyboard.press('Meta+Enter');
      const line = page.getByRole('alert');
      await line.waitFor();
      assert.deepEqual({ line: await line.textContent(), writes: await page.evaluate(() => window.writes), draft: await field(page).inputValue(), last: (await events(page)).at(-1) },
        { line: 'The server refused this save. Copy your draft to keep it.', writes: [], draft: `${GUIDE} Written`, last: { step: 'save', outcome: 'failed', length: '1-500', reason: 'refused' } });
      await page.getByRole('button', { name: 'Copy draft' }).click();
      await page.waitForFunction(() => window.events.some(({ props }) => props.step === 'copy'));
      assert.deepEqual({ footer: await page.locator('.st-guide-footer').textContent(), copied: await page.getByRole('status').count(), last: (await events(page)).at(-1) },
        { footer: 'The server refused this save. Copy your draft to keep it.CancelCopy draft', copied: 0, last: { step: 'copy', outcome: 'failed' } });
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.deepEqual({ line: await line.count(), draft: await field(page).inputValue(), issues: await issues(page) }, { line: 1, draft: `${GUIDE} Written`, issues: [] });
    });
  } finally { await page.close(); }
});

test('Chromium: the crossfade is for a guide set elsewhere alone: not for opening, returning from writing or the room\'s own save', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      const seen = [await arrivalFades(page)];
      await prose(page).press('Enter');
      await page.getByRole('button', { name: 'Cancel' }).click();
      seen.push(await arrivalFades(page));
      await prose(page).press('Enter');
      await page.keyboard.type(' Written');
      await page.keyboard.press('Meta+Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      seen.push(await arrivalFades(page));
      await page.evaluate((text) => window.setElsewhere(text), ELSEWHERE);
      await page.waitForFunction((text) => document.querySelector('.st-guide-prose').textContent === text, ELSEWHERE);
      seen.push(await arrivalFades(page));
      assert.deepEqual(seen, [0, 0, 0, 1]);
    });
  } finally { await page.close(); }
});

test('Chromium: a double tap on the phone\'s row opens the sheet and leaves it open', async () => {
  const page = await open({ guide: GUIDE, band: 'phone' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(page, async () => {
      await page.getByRole('button', { name: 'Guide: One step a week.' }).dblclick();
      await settled(page);
      assert.equal(await page.getByRole('dialog', { name: 'Guide', exact: true }).count(), 1);
      await page.locator('.st-guide-backdrop').click({ position: { x: 20, y: 20 } });
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    });
  } finally { await page.close(); }
});

test('Chromium: the note dissolves in over 160ms and Discard draft? over 120ms, the field\'s caret is the brand colour, the entry answers hover and press, and the phone\'s keyboard ring is inset', async () => {
  const page = await open({ guide: GUIDE });
  try {
    await withBrowserErrors(page, async () => {
      const card = page.locator('.st-guide-card');
      const rest = await card.evaluate((button) => getComputedStyle(button).backgroundColor);
      await card.hover();
      await page.waitForFunction((before) => getComputedStyle(document.querySelector('.st-guide-card')).backgroundColor !== before, rest);
      await page.mouse.down();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-guide-card')).transform === 'matrix(0.97, 0, 0, 0.97, 0, 0)');
      await page.mouse.up();
      assert.deepEqual(await page.locator('.st-guide-paper').evaluate((paper) => paper.getAnimations().map((animation) => [animation.animationName, animation.effect.getTiming().duration, getComputedStyle(paper).animationTimingFunction])),
        [['st-guide-dissolve', 160, 'ease-out']]);
      await page.getByRole('button', { name: 'Edit guide' }).click();
      assert.deepEqual(await field(page).evaluate((box) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-brand)';
        box.parentElement.append(probe);
        const brand = getComputedStyle(probe).color;
        probe.remove();
        return [getComputedStyle(box).caretColor === brand, box.getAnimations().map((animation) => animation.effect.getTiming().duration)];
      }), [true, [160]]);
      await page.keyboard.type(' Written');
      await page.keyboard.press('Escape');
      assert.deepEqual(await page.locator('.st-guide-discard').evaluate((asked) => asked.getAnimations().map((animation) => animation.effect.getTiming().duration)), [120]);
    });
  } finally { await page.close(); }
  const phone = await open({ guide: GUIDE, band: 'phone' }, { width: 390, height: 844 });
  try {
    await withBrowserErrors(phone, async () => {
      await phone.locator('.st-guide-row').focus();
      await phone.keyboard.press('Enter');
      await phone.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      assert.deepEqual(await prose(phone).evaluate((shown) => {
        const style = getComputedStyle(shown);
        const box = shown.getBoundingClientRect();
        return [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.borderRadius, box.left, window.innerWidth - box.right];
      }), ['solid', '2px', '-2px', '5px', 18, 18]);
    });
  } finally { await phone.close(); }
});
