import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { GUIDE, events, field, hostGuideSurfaces, open } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-phone-test' });

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: phone owner reads and edits through the mounted Roadmap sheet`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone', sheet: true }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      const entry = page.getByRole('button', { name: 'Guide', exact: true });
      assert.equal(await entry.evaluate((button) => button.getBoundingClientRect().height), 48);
      await entry.click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual(await note.evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        const heading = dialog.querySelector('header').getBoundingClientRect();
        const text = dialog.querySelector('.st-guide-prose');
        const style = getComputedStyle(text);
        return { page: [box.x, box.y, box.width, box.height], heading: heading.height,
          prose: [text.getBoundingClientRect().x, style.fontSize, style.lineHeight],
          sheet: document.querySelector('.st-board-sheet-layer').inert };
      }), { page: [0, 52, 390, 792], heading: 72, prose: [22, '17px', '25px'], sheet: true });
      if (process.env.GUIDE_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/${engine.name()}-phone-read.png` });
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('Sail every Sunday.');
      assert.deepEqual(await page.locator('.st-guide-footer').evaluate((footer) => {
        const box = footer.getBoundingClientRect();
        return [box.height, box.bottom, footer.querySelector('.st-guide-save').getBoundingClientRect().height];
      }), [82, 844, 44]);
      if (process.env.GUIDE_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/${engine.name()}-phone-edit.png` });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal(await page.locator('.st-guide-prose').textContent(), 'Sail every Sunday.');
      await note.getByRole('button', { name: 'Close', exact: true }).click();
      await note.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
      assert.equal(await page.getByRole('dialog', { name: 'Roadmap', exact: true }).count(), 1);
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'sheet', view: 'graph', role: 'owner', above: 'none' },
        { step: 'edit', via: 'pencil' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ]);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: unknown phone parent status opens reading, wraps at 320px and adds only the own Guide`, async () => {
    for (const text of ['', GUIDE]) {
      const page = await open({ guide: text, aboveUnread: true, band: 'phone', sheet: true }, { engine, width: 320, height: 844, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      try {
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
        const entry = page.getByRole('button', { name: 'Guide · parent status unknown', exact: true });
        assert.equal(await entry.textContent(), 'Guide · ?');
        await entry.focus();
        await page.keyboard.press('Enter');
        const note = page.getByRole('dialog', { name: 'Guide', exact: true });
        await note.waitFor();
        assert.equal(await field(page).count(), 0);
        assert.deepEqual(await page.getByRole('status').evaluate((notice) => {
          const box = notice.getBoundingClientRect();
          return { text: notice.textContent, x: box.x, width: box.width, height: box.height, wraps: notice.scrollWidth === notice.clientWidth };
        }), { text: 'Parent Guide status has not been confirmed.', x: 22, width: 276, height: 48, wraps: true });
        assert.deepEqual(await page.locator('.st-guide-prose').allTextContents(), text ? [text] : []);
        await page.getByRole('button', { name: text ? 'Edit guide' : 'Add guide', exact: true }).click();
        await field(page).fill('My own guide.');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        assert.equal(await page.locator('.st-guide-prose').textContent(), 'My own guide.');
        await page.keyboard.press('Escape');
        await note.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
        assert.deepEqual(await page.evaluate(() => window.writes), ['My own guide.']);
        assert.deepEqual((await events(page))[0], { step: 'open', door: 'sheet', view: 'graph', role: 'owner', above: 'unread' });
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: direct Add exits to the sheet after clean cancel, discard and first Save`, async () => {
    const page = await open({ band: 'phone', sheet: true }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      await page.getByRole('button', { name: 'Add guide', exact: true }).click();
      await field(page).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
      await page.keyboard.press('Enter');
      await field(page).fill('A draft to discard.');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Discard draft?' });
      assert.equal(await confirmation.evaluate((dialog) => dialog === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await confirmation.count(), 0);
      assert.equal(await field(page).inputValue(), 'A draft to discard.');
      await page.keyboard.press('Escape');
      await confirmation.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
      await page.keyboard.press('Enter');
      await field(page).fill('First saved guide.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
      assert.equal(await page.getByRole('button', { name: 'Guide', exact: true }).textContent(), 'Guide');
      assert.equal(await page.locator('.st-guide-paper').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.writes), ['First saved guide.']);
    } finally { await page.close(); }
  });
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: inherited-only pencil and Add both edit only the current roadmap`, async () => {
    const page = await open({ above: [{ treeId: 'life', title: 'My life', text: 'Health first.' }, { treeId: 'year', title: 'My year', text: 'Sail, run, read.' }], band: 'phone', sheet: true },
      { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      const entry = page.getByRole('button', { name: 'Guide · 2 guides from above', exact: true });
      assert.equal(await entry.textContent(), 'Guide · +2 from above');
      await entry.click();
      assert.deepEqual(await page.locator('.st-guide-from-text').allTextContents(), ['Health first.', 'Sail, run, read.']);
      assert.equal(await page.locator('.st-guide-own').count(), 0);
      await page.locator('.st-guide-pencil').click();
      assert.equal(await field(page).inputValue(), '');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.locator('.st-guide-from-text').count(), 2);
      await page.locator('.st-guide-add').click();
      await field(page).fill('My own sailing guide.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      assert.deepEqual(await page.locator('.st-guide-from-text, .st-guide-prose').allTextContents(), ['Health first.', 'Sail, run, read.', 'My own sailing guide.']);
      assert.deepEqual(await page.evaluate(() => window.writes), ['My own sailing guide.']);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a phone draft and recovery survive a band change and loss of ownership`, async () => {
    const page = await open({ band: 'phone', sheet: true }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      await page.getByRole('button', { name: 'Add guide', exact: true }).click();
      await field(page).fill('Keep this unfinished draft.');
      await page.setViewportSize({ width: 744, height: 844 });
      await page.evaluate(() => window.setRoom({ band: 'tablet' }));
      await page.locator('.st-roadmap-identity--tablet').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.st-board-sheet').count(), 0);
      assert.equal(await field(page).inputValue(), 'Keep this unfinished draft.');
      await page.evaluate(() => window.setRoom({ owner: false }));
      await page.locator('.st-roadmap-identity[data-role="reader"]').waitFor({ state: 'attached' });
      assert.equal(await field(page).inputValue(), 'Keep this unfinished draft.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      assert.equal(await page.getByRole('alert').textContent(), 'The server refused this save. Copy your draft to keep it.');
      assert.deepEqual(await page.evaluate(() => window.writes), []);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.setRoom({ band: 'phone' }));
      await page.locator('.st-roadmap-identity--phone').waitFor({ state: 'attached' });
      assert.equal(await field(page).inputValue(), 'Keep this unfinished draft.');
      assert.equal(await page.getByRole('button', { name: 'Copy draft', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.locator('.st-guide-paper').waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('alertdialog').count(), 0);
      await page.waitForFunction(() => document.activeElement.matches('.st-roadmap-title'));
    } finally { await page.close(); }
  });

  test(`${engine.name()}: a parent response preserves selected own prose and any active phone draft`, async () => {
    const page = await open({ mount: false }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      let reply;
      await page.route('**/v1/trees/sail/guides', (route) => { reply = route; });
      await page.evaluate((guide) => window.mount({ guide, band: 'phone', sheet: true, holder: 'owner' }), GUIDE);
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      await page.getByRole('button', { name: 'Guide · parent status unknown', exact: true }).click();
      await page.locator('.st-guide-prose').evaluate((prose) => {
        window.selectedProse = prose;
        const range = document.createRange();
        range.setStart(prose.firstChild, 0);
        range.setEnd(prose.firstChild, 8);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await reply.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ guides: [{ treeId: 'life', title: 'My life', text: 'Health first.', yours: true }] }) });
      await page.locator('.st-guide-from-text').waitFor();
      assert.deepEqual(await page.evaluate(() => ({ same: document.querySelector('.st-guide-prose') === window.selectedProse, selection: getSelection().toString() })), { same: true, selection: 'One step' });
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('Still my local draft.');
      await page.evaluate(() => window.setRoom({ holder: null }));
      assert.equal(await field(page).inputValue(), 'Still my local draft.');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.setElsewhere(''));
      assert.equal(await page.getByRole('alertdialog').evaluate((dialog) => dialog.contains(document.activeElement)), true);
      assert.equal(await field(page).inputValue(), 'Still my local draft.');
    } finally { await page.close(); }
  });
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: unknown parent status retains usable inherited text and focus after own text clears`, async () => {
    const page = await open({ guide: GUIDE, band: 'phone', sheet: true, aboveUnread: true,
      above: [{ treeId: 'life', title: 'My life', text: 'Health first.' }] }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    try {
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      const entry = page.getByRole('button', { name: 'Guide · parent status unknown', exact: true });
      assert.equal(await entry.textContent(), 'Guide · ?');
      await entry.click();
      assert.deepEqual(await page.locator('.st-guide-from-text, .st-guide-prose').allTextContents(), ['Health first.', GUIDE]);
      await page.locator('.st-guide-prose').focus();
      await page.evaluate(() => window.setElsewhere(''));
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-add'));
      assert.equal(await page.locator('.st-guide-pencil').count(), 0);
      assert.equal(await page.getByRole('status').textContent(), 'Parent Guide status has not been confirmed.');
      assert.equal(await page.locator('.st-guide-from-text').textContent(), 'Health first.');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
    } finally { await page.close(); }
  });
}
