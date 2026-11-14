import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { GUIDE, events, field, hostGuideSurfaces, open, settled } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-identity-entry-test' });

test('the identity entry represents own, parent, unknown and empty states at every wide band and theme', async () => {
  for (const width of [744, 1024, 1440]) for (const theme of ['light', 'dark']) {
    for (const [state, options, expected] of [
      ['own', { guide: GUIDE }, { label: 'Guide: One step a week.', line: 'One step a week.', count: '' }],
      ['reader', { guide: GUIDE, role: 'reader' }, { label: 'Author’s note: One step a week.', line: 'One step a week.', count: '' }],
      ['parents', { above: [{ treeId: 'life', title: 'My life', text: 'Life guide' }, { treeId: 'year', title: 'My year', text: 'Year guide' }] },
        { label: 'Guide · 2 guides from above', line: '2 guides from above', count: '2' }],
      ['both', { guide: GUIDE, above: [{ treeId: 'life', title: 'My life', text: 'Life guide' }, { treeId: 'year', title: 'My year', text: 'Year guide' }] },
        { label: 'Guide: One step a week. · 2 guides from above', line: '+2 above · One step a week.', count: '2' }],
      ['unknown', { aboveUnread: true }, { label: 'Guide · parent status unknown', line: 'Guide · unknown', count: '?' }],
      ['own-unknown', { guide: GUIDE, aboveUnread: true }, { label: 'Guide · parent status unknown', line: '? · One step a week.', count: '?' }],
      ['empty', {}, { label: 'Add guide', line: 'Add guide', count: '' }],
      ['empty-reader', { role: 'reader' }, null],
    ]) {
      const page = await open({ ...options, band: width < 1024 ? 'tablet' : 'desktop' }, { width, height: 960, reducedMotion: 'reduce' });
      try {
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        await page.evaluate(() => document.fonts.ready);
        const entry = page.locator('.st-guide-entry');
        if (!expected) {
          assert.equal(await entry.count(), 0);
          continue;
        }
        const actual = await entry.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const row = button.closest('.st-roadmap-identity');
          const switchBox = row.querySelector('.st-board-switch').getBoundingClientRect();
          const rowBox = row.getBoundingClientRect();
          const icon = button.querySelector('svg').getBoundingClientRect();
          return { label: button.getAttribute('aria-label'), text: button.textContent, height: box.height,
            width: box.width, afterSwitch: Math.abs(box.left - switchBox.right - 8) < 1,
            insideRow: box.top >= rowBox.top && box.bottom <= rowBox.bottom,
            icon: [icon.width, icon.height], dashed: getComputedStyle(button).borderStyle === 'dashed' };
        });
        assert.deepEqual({ ...actual, width: undefined }, {
          label: expected.label, text: width === 744 ? expected.count : expected.line, height: 44,
          width: undefined, afterSwitch: true, insideRow: true, icon: [20, 20], dashed: state === 'empty',
        }, `${width} ${theme} ${state}`);
        assert.equal(actual.width <= (width === 744 ? 72 : width === 1024 ? 200 : 320), true);
        if (process.env.GUIDE_ARTIFACT_DIR && ['both', 'unknown'].includes(state)) {
          await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/${width}-${theme}-${state}.png` });
        }
      } finally { await page.close(); }
    }
  }
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: real Tab reaches one compact Guide control, its count shares the ring and tooltip, Enter reads, and Escape returns`, async () => {
    const page = await open({ band: 'tablet', above: [{ treeId: 'life', title: 'My life', text: 'Life guide' }, { treeId: 'year', title: 'My year', text: 'Year guide' }] },
      { engine, width: 744, height: 960, reducedMotion: 'reduce' });
    try {
      for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
      const entry = page.getByRole('button', { name: 'Guide · 2 guides from above', exact: true });
      assert.equal(await entry.evaluate((button) => button === document.activeElement), true);
      assert.deepEqual(await entry.evaluate((button) => {
        const count = button.querySelector('.st-guide-entry-count').getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return { ring: getComputedStyle(button).outlineWidth, countInside: count.left >= box.left && count.right <= box.right };
      }), { ring: '2px', countInside: true });
      assert.equal(await page.getByRole('tooltip').textContent(), 'Guide · 2 guides from above');
      await page.keyboard.press('Enter');
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      await note.waitFor();
      assert.deepEqual(await page.locator('.st-guide-from-text').allTextContents(), ['Life guide', 'Year guide']);
      assert.equal(await field(page).count(), 0);
      await page.keyboard.press('Escape');
      await note.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
      assert.deepEqual(await events(page), [{ step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'some' }]);
    } finally { await page.close(); }
  });

  test(`${engine.name()}: unknown parent status reads a stable viewer, keeps own text and offers Add only to the owner`, async () => {
    for (const own of [false, true]) for (const owner of [false, true]) {
      const page = await open({ guide: own ? GUIDE : '', aboveUnread: true, guideOwner: owner, band: own ? 'desktop' : 'tablet' },
        { engine, width: own ? 1440 : 744, height: 960, reducedMotion: 'reduce' });
      try {
        if (!own) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
        assert.equal(await page.locator('.st-guide-entry').evaluate((button) => document.activeElement === button), true);
        await page.keyboard.press('Enter');
        const note = page.getByRole('dialog', { name: owner ? 'Guide' : 'Author’s note', exact: true });
        await note.waitFor();
        assert.equal(await page.getByRole('status').textContent(), 'Parent Guide status has not been confirmed.');
        assert.equal(await field(page).count(), 0);
        assert.deepEqual(await page.locator('.st-guide-prose').allTextContents(), own ? [GUIDE] : []);
        assert.equal(await note.getByRole('button', { name: 'Add guide' }).count(), owner && !own ? 1 : 0);
        if (process.env.GUIDE_ARTIFACT_DIR && engine === chromium && owner) {
          await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/unknown-viewer-${own ? 'own-light' : 'empty-dark'}.png` });
        }
        if (owner && !own) {
          assert.equal(await note.evaluate((dialog) => dialog.querySelector('.st-guide-add').getBoundingClientRect().top
            - dialog.querySelector('.st-guide-parent-status').getBoundingClientRect().bottom), 32);
          assert.equal(await page.locator('.st-guide-add').evaluate((button) => document.activeElement === button), true);
          await page.keyboard.press('Enter');
          await field(page).waitFor();
          await page.keyboard.type('A first guide');
          await page.keyboard.press('Control+Enter');
          await note.waitFor();
          assert.equal(await page.locator('.st-guide-prose').textContent(), 'A first guide');
          assert.deepEqual(await page.evaluate(() => window.writes), ['A first guide']);
        }
        await page.keyboard.press('Escape');
        await note.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
        assert.deepEqual((await events(page))[0], { step: 'open', door: 'row', view: 'graph', role: owner ? 'owner' : 'reader', above: 'unread' });
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: confirmed-empty Add enters writing directly through the keyboard`, async () => {
    const page = await open({}, { engine, reducedMotion: 'reduce' });
    try {
      for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Add guide' }).waitFor();
      assert.equal(await field(page).evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
      assert.deepEqual(await events(page), [
        { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' },
        { step: 'edit', via: 'add' }, { step: 'cancel' },
      ]);
    } finally { await page.close(); }
  });
}

test('a remote Guide arrival flashes the wide entry once, while reduced motion and own saves stay still', async () => {
  for (const motion of ['no-preference', 'reduce']) {
    const page = await open({ guide: GUIDE }, { reducedMotion: motion });
    try {
      const entry = page.locator('.st-guide-entry');
      assert.equal(await entry.evaluate((button) => button.getAnimations().some((animation) => animation.animationName === 'wm-switcher-flash')), false);
      await page.evaluate(() => window.setElsewhere('A new first line.\nThe rest remains private.'));
      assert.equal(await entry.textContent(), 'A new first line.');
      assert.equal(await entry.evaluate((button) => button.getAnimations().some((animation) => animation.animationName === 'wm-switcher-flash')), motion !== 'reduce');
      await settled(page);
      await entry.click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      await field(page).fill('Saved here.');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      assert.equal(await entry.textContent(), 'Saved here.');
      assert.equal(await entry.evaluate((button) => button.getAnimations().some((animation) => animation.animationName === 'wm-switcher-flash')), false);
    } finally { await page.close(); }
  }
});

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: a remote clear in the unknown viewer keeps keyboard focus inside the modal`, async () => {
    for (const owner of [true, false]) for (const focusClose of [false, true]) {
      const page = await open({ guide: GUIDE, aboveUnread: true, guideOwner: owner }, { engine, reducedMotion: 'reduce' });
      try {
        for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
        await page.keyboard.press('Enter');
        const note = page.getByRole('dialog', { name: owner ? 'Guide' : 'Author’s note', exact: true });
        await note.waitFor();
        assert.equal(await page.locator('.st-guide-prose').evaluate((prose) => prose === document.activeElement), true);
        if (focusClose) await page.keyboard.press('Shift+Tab');
        await page.evaluate(() => window.setElsewhere(''));
        await page.locator('.st-guide-prose').waitFor({ state: 'detached' });
        assert.equal(await note.evaluate((dialog) => dialog.contains(document.activeElement)), true);
        const target = note.getByRole('button', { name: owner && !focusClose ? 'Add guide' : 'Close', exact: true });
        assert.equal(await target.evaluate((button) => button === document.activeElement), true);
        assert.equal(await page.getByRole('status').textContent(), 'Parent Guide status has not been confirmed.');
        await page.keyboard.press('Escape');
        await note.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: concise Guide tooltips name the reader, confirmed parent count, unknown status or Add`, async () => {
    for (const [options, label] of [
      [{ role: 'reader' }, 'Author’s note'],
      [{ above: [{ treeId: 'life', title: 'Life', text: 'Health first.' }] }, 'Guide · 1 guide from above'],
      [{ above: [{ treeId: 'life', title: 'Life', text: 'Health first.' }, { treeId: 'year', title: 'Year', text: 'Learn to sail.' }] }, 'Guide · 2 guides from above'],
      [{ aboveUnread: true }, 'Guide · parent status unknown'],
      [{ guide: '' }, 'Add guide'],
    ]) {
      const page = await open({ guide: GUIDE, ...options, band: 'tablet' }, { engine, width: 744, reducedMotion: 'reduce' });
      try {
        for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
        assert.deepEqual(await page.getByRole('tooltip').evaluate((tooltip) => {
          const bounds = tooltip.getBoundingClientRect();
          return { text: tooltip.textContent, inside: bounds.left >= 0 && bounds.right <= innerWidth };
        }), { text: label, inside: true });
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: remote Guide changes preserve the active draft and its discard confirmation focus`, async () => {
    const page = await open({ guide: GUIDE, aboveUnread: true }, { engine, reducedMotion: 'reduce' });
    try {
      for (let press = 0; press < 4; press += 1) await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
      await page.keyboard.press('Enter');
      await field(page).waitFor();
      await page.keyboard.type(' Local draft.');
      await page.evaluate(() => window.setElsewhere(''));
      assert.equal(await field(page).evaluate((draft) => draft === document.activeElement), true);
      assert.equal(await field(page).inputValue(), `${GUIDE} Local draft.`);
      await page.keyboard.press('Escape');
      const confirmation = page.getByRole('alertdialog', { name: 'Discard draft?' });
      await confirmation.waitFor();
      await page.evaluate(() => window.setElsewhere('A replacement guide.'));
      assert.equal(await confirmation.evaluate((dialog) => dialog.contains(document.activeElement)), true);
      assert.equal(await field(page).inputValue(), `${GUIDE} Local draft.`);
    } finally { await page.close(); }
  });
}
