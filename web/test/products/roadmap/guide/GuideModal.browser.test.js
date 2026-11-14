import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { GUIDE, events, hostGuideSurfaces, open, origin, settled, stepInert } from './guideSurfacesHost.js';

hostGuideSurfaces({ cache: 'guide-modal-window-test' });

for (const engine of [chromium, webkit]) {
  for (const [width, band] of [[744, 'tablet'], [1440, 'desktop']]) {
    for (const role of ['owner', 'reader']) {
      test(`${engine.name()}: ${role} reads the ${width}px Guide in a modal and returns to its entry`, async () => {
        const page = await open({ guide: GUIDE, band, role }, { engine, width, height: 960, reducedMotion: 'reduce' });
        try {
          await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
          const title = role === 'owner' ? 'Guide' : 'Author’s note';
          const entry = page.getByRole('button', { name: `${title}: One step a week.` });
          await entry.click();
          const note = page.getByRole('dialog', { name: title, exact: true });
          await note.waitFor();
          await settled(page);
          const box = await note.boundingBox();
          assert.deepEqual({ box: [box.x, box.y, box.width, box.height], modal: await note.getAttribute('aria-modal'), tree: await stepInert(page), text: await page.locator('.st-guide-prose').textContent() },
            { box: [24, 24, width - 48, 912], modal: 'true', tree: true, text: GUIDE });
          assert.equal(await note.getByRole('button', { name: 'Edit guide' }).count(), role === 'owner' ? 1 : 0);
          for (let press = 0; press < 4; press += 1) {
            await page.keyboard.press('Tab');
            assert.equal(await note.evaluate((element) => element.contains(document.activeElement)), true);
          }
          await page.keyboard.press('Escape');
          await note.waitFor({ state: 'detached' });
          await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
          assert.equal(await stepInert(page), false);
        } finally { await page.close(); }
      });
    }
  }

  test(`${engine.name()}: disappearing Close and Edit controls hand focus to their counterparts across 744px`, async () => {
    const editing = await open({ guide: GUIDE, band: 'desktop' }, { engine, width: 1024, height: 800, reducedMotion: 'reduce' });
    try {
      await editing.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await editing.getByRole('button', { name: 'Edit guide' }).click();
      await editing.getByRole('button', { name: 'Close', exact: true }).focus();
      await editing.setViewportSize({ width: 390, height: 844 });
      await editing.evaluate(() => window.setRoom({ band: 'phone' }));
      await editing.waitForFunction(() => document.activeElement.matches('.st-guide-cancel'));
      assert.equal(await editing.getByRole('dialog', { name: 'Edit guide' }).evaluate((dialog) => dialog.contains(document.activeElement)), true);
    } finally { await editing.close(); }

    const reading = await open({ guide: GUIDE, band: 'phone' }, { engine, width: 390, height: 844, reducedMotion: 'reduce' });
    try {
      await reading.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await reading.getByRole('button', { name: 'Edit guide' }).focus();
      await reading.setViewportSize({ width: 1024, height: 800 });
      await reading.evaluate(() => window.setRoom({ band: 'desktop' }));
      await reading.waitForFunction(() => document.activeElement.matches('.st-guide-edit'));
      assert.equal(await reading.getByRole('dialog', { name: 'Guide', exact: true }).evaluate((dialog) => dialog.contains(document.activeElement)), true);
    } finally { await reading.close(); }
  });

  test(`${engine.name()}: leaving an unchanged edit emits one content-free cancellation`, async () => {
    for (const door of ['close', 'cancel', 'escape', 'backdrop']) {
      const page = await open({ guide: GUIDE }, { engine, reducedMotion: 'reduce' });
      try {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        if (door === 'close') await page.getByRole('button', { name: 'Close', exact: true }).click();
        if (door === 'cancel') await page.getByRole('button', { name: 'Cancel' }).click();
        if (door === 'escape') await page.keyboard.press('Escape');
        if (door === 'backdrop') await page.mouse.click(10, 10);
        await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
        assert.deepEqual(await events(page), [
          { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' },
          { step: 'edit', via: 'pencil' },
          { step: 'cancel' },
        ], door);
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: a short window keeps a changed-elsewhere notice, draft and actions separate`, async () => {
    for (const height of [280, 400, 600]) {
      const page = await open({ guide: GUIDE, band: 'tablet' }, { engine, width: 744, height, reducedMotion: 'reduce' });
      try {
        await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
        await page.getByRole('button', { name: 'Edit guide' }).click();
        const draft = 'A long line of guide text.\n'.repeat(180);
        await page.locator('.st-guide-field').fill(draft);
        await page.evaluate(() => window.setElsewhere('Changed somewhere else'));
        await page.getByRole('status').waitFor();
        await settled(page);
        const { layout, bounds } = await page.locator('.st-guide-paper').evaluate((paper) => {
          const [notice, field, footer, save] = ['.st-guide-status', '.st-guide-field', '.st-guide-footer', '.st-guide-actions > :last-child']
            .map((selector) => paper.querySelector(selector).getBoundingClientRect().toJSON());
          const frame = paper.getBoundingClientRect().toJSON();
          return { bounds: { notice, field, footer, save, frame },
            layout: { noticeAboveField: notice.bottom <= field.top, fieldAboveFooter: field.bottom <= footer.top,
              footerInWindow: footer.bottom <= frame.bottom, actionInWindow: save.bottom <= frame.bottom, fieldVisible: field.height > 0 } };
        });
        assert.deepEqual(layout, { noticeAboveField: true, fieldAboveFooter: true, footerInWindow: true, actionInWindow: true, fieldVisible: true }, `${height}px: ${JSON.stringify(bounds)}`);
        assert.equal(await page.locator('.st-guide-field').inputValue(), draft);
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
        await page.getByRole('button', { name: 'Keep editing' }).click();
        assert.equal(await page.locator('.st-guide-field').inputValue(), draft);
      } finally { await page.close(); }
    }
  });

  test(`${engine.name()}: a short window keeps a failed save and changed-elsewhere notice reachable`, async () => {
    const page = await open({ guide: GUIDE, band: 'tablet', door: 'server' }, { engine, width: 744, height: 280, reducedMotion: 'reduce' });
    try {
      await page.route('**/v1/trees/**', (route) => {
        const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'PATCH', 'access-control-allow-headers': 'content-type' };
        return route.fulfill({ status: route.request().method() === 'PATCH' ? 503 : 204, headers });
      });
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      const draft = 'A long line of guide text.\n'.repeat(180);
      await page.locator('.st-guide-field').fill(draft);
      await page.evaluate(() => window.setElsewhere('Changed somewhere else'));
      await page.getByRole('status').waitFor();
      await page.getByRole('button', { name: 'Save' }).click();
      assert.equal(await page.getByRole('alert').textContent(), 'Couldn’t save just now. Try again in a moment.');
      await settled(page);
      assert.deepEqual(await page.locator('.st-guide-paper').evaluate((paper) => {
        const [notice, field, footer, retry] = ['.st-guide-status', '.st-guide-field', '.st-guide-footer', '.st-guide-actions > :last-child']
          .map((selector) => paper.querySelector(selector).getBoundingClientRect());
        const frame = paper.getBoundingClientRect();
        return { noticeAboveField: notice.bottom <= field.top, fieldAboveFooter: field.bottom <= footer.top,
          retryInWindow: retry.bottom <= frame.bottom, fieldVisible: field.height > 0 };
      }), { noticeAboveField: true, fieldAboveFooter: true, retryInWindow: true, fieldVisible: true });
      assert.equal(await page.locator('.st-guide-field').inputValue(), draft);
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('alertdialog', { name: 'Discard draft?' }).waitFor();
    } finally { await page.close(); }
  });
}

test('a short tablet window keeps the draft and footer actions separate and reachable', async () => {
  const page = await open({ guide: GUIDE, band: 'tablet' }, { width: 744, height: 280, reducedMotion: 'reduce' });
  try {
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    const field = page.locator('.st-guide-field');
    await field.fill(`${GUIDE} Written`);
    await settled(page);
    assert.deepEqual(await page.locator('.st-guide-paper').evaluate((paper) => {
      const [draft, footer, save] = ['.st-guide-field', '.st-guide-footer', '.st-guide-actions > :last-child']
        .map((selector) => paper.querySelector(selector).getBoundingClientRect());
      const frame = paper.getBoundingClientRect();
      return { separated: draft.bottom <= footer.top, reachable: save.bottom <= frame.bottom, scrolls: paper.querySelector('.st-guide-field').scrollHeight > paper.querySelector('.st-guide-field').clientHeight };
    }), { separated: true, reachable: true, scrolls: true });
    await page.getByRole('button', { name: 'Save' }).click();
    assert.deepEqual(await page.evaluate(() => window.writes), [`${GUIDE} Written`]);
  } finally { await page.close(); }
});
