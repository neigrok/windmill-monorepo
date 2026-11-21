import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStepDetailHost, calls, card, events, focusedName } from './stepDetailHost.js';

const host = createStepDetailHost('copy-boundaries');
const { start, openRoom } = host;
after(host.close);

for (const engine of ['Chromium', 'WebKit']) {
  test(`${engine}: copy recovery keeps a nested editor, sync refusal, Coach and completion Undo intact`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 744, height: 960 }, editingEnabled: true }, errors);
    try {
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError')); });
      });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      await page.evaluate(() => window.refuseSync());
      await page.getByRole('alert').waitFor();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.getByRole('button', { name: 'Edit name', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.locator('.st-inline-field').waitFor();
      await page.getByRole('textbox', { name: 'Name', exact: true }).focus();
      await page.evaluate(() => window.refuseCopy());
      await page.waitForFunction(() => document.querySelector('.st-step-copy-recovery'));
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).evaluate((input) => input === document.activeElement), true);
      await page.keyboard.press('Escape');
      await page.locator('.st-inline-field').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'Edit name', null, { timeout: 4000 });
      assert.equal(await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Expand Coach' }).click();
      await page.getByRole('button', { name: 'Collapse Coach' }).click();
      await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual(await calls(page), ['complete wind', 'restore wind']);
      assert.equal(await page.locator('.st-board-step-status-label').textContent(), 'Up next');
      await page.getByRole('button', { name: 'Expand Coach' }).focus();
      await page.keyboard.press('Escape');
      await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).waitFor({ state: 'detached' });
      assert.equal(await focusedName(page), 'More');
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  test(`${engine}: copy recovery keeps Copy pending across step navigation until the native write settles`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 1440, height: 960 } }, errors);
    try {
      await page.evaluate(() => {
        window.copyRequests = [];
        navigator.clipboard.writeText = (link) => new Promise((resolve) => { window.copyRequests.push(link); window.finishCopy = resolve; });
      });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.getByRole('button', { name: 'Name the boat parts, done' }).click();
      await page.getByRole('article', { name: 'Name the boat parts', exact: true }).waitFor();
      await page.getByRole('button', { name: 'More' }).click();
      const copy = page.getByRole('menuitem', { name: 'Copy link' });
      assert.equal(await copy.getAttribute('aria-disabled'), 'true');
      assert.equal(await focusedName(page), 'Copy link');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.deepEqual([await page.getByRole('menu').count(), await focusedName(page), await page.evaluate(() => window.copyRequests), await calls(page)],
        [1, 'Copy link', ['https://windmill.test/t/sail#?step=wind'], []]);
      await page.keyboard.press('ArrowDown');
      assert.equal(await focusedName(page), 'Open in Graph');
      await page.keyboard.press('ArrowUp');
      await page.evaluate(() => window.finishCopy());
      await page.waitForFunction(() => document.querySelector('[role="menuitem"]').getAttribute('aria-disabled') !== 'true');
      assert.deepEqual([await focusedName(page), await calls(page), await page.locator('.st-step-copy-recovery').count()], ['Copy link', [], 0]);
      await page.keyboard.press('Enter');
      assert.deepEqual(await page.evaluate(() => window.copyRequests), ['https://windmill.test/t/sail#?step=wind', 'https://windmill.test/t/sail#?step=parts']);
      await page.evaluate(() => window.finishCopy());
      await page.waitForFunction(() => window.calls.length === 1);
      assert.deepEqual(await calls(page), ['notify Link copied']);
      assert.deepEqual((await events(page)).filter((line) => line.includes('copyLink')), Array(2).fill('roadmap_board_step_action {"surface":"document","action":"copyLink","outcome":"ok"}'));
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });

  for (const width of [390, 1440]) {
    test(`${engine}: copy recovery stays inside a newer Delete confirmation boundary at ${width}px`, async () => {
      await start();
      const errors = [];
      const page = await openRoom({ engine, viewport: { width, height: 960 } }, errors);
      try {
        await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError')); }); });
        await card(page, 'Read the wind').click();
        await page.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Copy link' }).click();
        await page.getByRole('button', { name: 'More' }).click();
        await page.getByRole('menuitem', { name: 'Delete step' }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.waitFor();
        await page.waitForFunction(() => document.querySelector('[role="alertdialog"]').contains(document.activeElement));
        await page.evaluate(() => window.refuseCopy());
        const recovery = page.locator('.st-step-copy-recovery');
        await recovery.waitFor({ state: 'attached' });
        assert.deepEqual(await page.evaluate(() => ({
          focus: document.activeElement.textContent,
          inDialog: document.querySelector('[role="alertdialog"]').contains(document.activeElement),
          inert: !!document.querySelector('.st-step-copy-recovery').closest('[inert]'),
        })), { focus: 'Cancel', inDialog: true, inert: true });
        await recovery.getByRole('button', { name: 'Try again' }).evaluate((node) => node.focus());
        assert.equal(await focusedName(page), 'Cancel');
        if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-${width}-delete-late-failure.png` });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement.getAttribute('aria-label') === 'More');
        assert.deepEqual([await recovery.count(), await recovery.evaluate((node) => !!node.closest('[inert]')), await calls(page)], [1, false, []]);
        await page.keyboard.press('Escape');
        await recovery.waitFor({ state: 'detached' });
        assert.deepEqual([await focusedName(page), await page.getByRole('article').count()], ['More', 1]);
        assert.deepEqual(errors, []);
      } finally { await page.context().close(); }
    });
  }

  test(`${engine}: copy recovery preserves a newer workspace note draft and its focus`, async () => {
    await start();
    const errors = [];
    const page = await openRoom({ engine, viewport: { width: 1440, height: 960 } }, errors);
    try {
      await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise((_resolve, reject) => { window.refuseCopy = () => reject(new DOMException('private detail', 'NotAllowedError')); }); });
      await card(page, 'Read the wind').click();
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Copy link' }).click();
      await page.locator('.st-step-section-links').getByRole('button', { name: /Workspace/i }).click();
      await page.getByRole('button', { name: 'Add note', exact: true }).click();
      const note = page.getByRole('textbox', { name: 'Note', exact: true });
      await note.fill('Still drafting');
      await page.evaluate(() => window.refuseCopy());
      await page.locator('.st-step-copy-recovery').waitFor({ state: 'attached' });
      assert.deepEqual(await note.evaluate((node) => ({ focused: node === document.activeElement, text: node.textContent })), { focused: true, text: 'Still drafting' });
      await page.keyboard.type(' after the failure');
      assert.equal(await note.textContent(), 'Still drafting after the failure');
      if (process.env.WM_COPY_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_COPY_SCREENSHOTS}/${engine}-note-late-failure.png` });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await note.waitFor({ state: 'detached' });
      assert.deepEqual(await calls(page), ['note wind']);
      assert.equal(await page.getByRole('region', { name: 'Couldn’t copy link', exact: true }).count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.context().close(); }
  });
}
