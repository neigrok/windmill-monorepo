import assert from 'node:assert/strict';
import { hostTest, openHost, origin, startRoadmapHost } from './skillTreeViewHost.js';
import { ASK_AI_PLACEHOLDER, DEMO_BYLINE, FORK_OFFER, LINK_COPIED, ROADMAP_SHEET, ROADMAP_VERBS } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('doors');

for (const [role, demo] of [['owner', false], ['reader', false], ['reader', true]]) {
  hostTest(`Chromium: view-open is once per visit for ${demo ? 'demo' : role}`, async () => {
    const { page, errors } = await openHost({ role, demo });
    try {
      await page.getByRole('button', { name: 'Board', exact: true }).click();
      await page.getByRole('button', { name: 'Graph', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_view_open')), [
        { name: 'roadmap_view_open', props: { view: 'graph', band: 'desktop', role: demo ? 'demo' : role, door: role === 'reader' && !demo ? 'default' : 'saved' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: the demo with no saved choice lands on the Graph through its default door', async () => {
  const { page, errors } = await openHost({ role: 'reader', demo: true, surface: 'none' });
  try {
    await page.locator('.st-roadmap-identity[data-role="demo"][data-view="tree"]').waitFor();
    await page.waitForFunction(() => window.events.some(({ name }) => name === 'roadmap_view_open'));
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_view_open')), [
      { name: 'roadmap_view_open', props: { view: 'graph', band: 'desktop', role: 'demo', door: 'default' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [1440, 744, 390]) {
  hostTest(`Chromium: demo identity at ${width}px keeps ${width >= 744 ? 'Share and Fork in the Board row' : 'its phone Board offer without a roadmap sheet'}`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true });
    try {
      const row = page.locator('.st-roadmap-identity[data-role="demo"]');
      await row.waitFor();
      assert.equal(await row.getByText(width < 744 ? DEMO_BYLINE.phone : DEMO_BYLINE.wide, { exact: true }).count(), 1);
      assert.equal(await page.locator('.st-demo-board-identity').count(), 0);
      if (width >= 744) {
        await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
        await page.locator('.st-board-toast-message').filter({ hasText: LINK_COPIED }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.copied), [`${origin}/t/t_sail`]);
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        assert.equal(await row.getAttribute('data-view'), 'board');
        await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
        await page.waitForFunction(() => window.copied.length === 2);
        assert.deepEqual(await page.evaluate(() => window.copied), [`${origin}/t/t_sail`, `${origin}/t/t_sail`]);
        assert.equal(await page.locator('.st-board-toast-message').textContent(), LINK_COPIED);
        await row.getByRole('button', { name: ROADMAP_VERBS.fork, exact: true }).click();
      } else {
        assert.equal(await row.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).count(), 0);
        assert.equal(await row.locator('.st-roadmap-title-button').count(), 0);
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        await page.getByRole('button', { name: FORK_OFFER, exact: true }).click();
      }
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement !== document.body);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [320, 390]) {
  for (const close of ['Escape', 'scrim', 'submit']) {
    hostTest(`Chromium: host phone Ask AI at ${width}px follows the keyboard and ${close} returns to the sheet title`, async () => {
      const { page, errors } = await openHost({ width, surface: 'board' });
      try {
        await page.evaluate(() => {
          const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: 500, offsetTop: 0, offsetLeft: 0 });
          Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
        });
        const title = page.locator('.st-roadmap-title-button');
        await title.click();
        await page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true })
          .getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
        const input = dialog.getByRole('textbox');
        await input.waitFor();
        await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
        assert.equal(await input.getAttribute('placeholder'), ASK_AI_PLACEHOLDER.phone);
        await page.waitForFunction(() => document.querySelector('.st-tend-overlay form').getBoundingClientRect().bottom === 488);
        assert.equal(await dialog.getAttribute('aria-modal'), 'true');
        if (close === 'Escape') await page.keyboard.press('Escape');
        if (close === 'scrim') await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
        if (close === 'submit') {
          await input.fill('Add a practice step');
          await input.press('Enter');
        }
        await dialog.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-title-button'));
        assert.equal(await title.evaluate((element) => element === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: the host 744 Ask AI overlay follows the measured row and Board filter strip', async () => {
  const { page, errors } = await openHost({ width: 744, surface: 'board', shell: true });
  try {
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
    await page.getByRole('menuitem', { name: ROADMAP_VERBS.askAI }).click();
    const dialog = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.wide);
    assert.equal(await page.evaluate(() => {
      const row = document.querySelector('.st-roadmap-identity').getBoundingClientRect();
      const filters = document.querySelector('.st-view-layer--board.is-active .st-board-strip').getBoundingClientRect();
      const form = document.querySelector('.st-tend-overlay form').getBoundingClientRect();
      return form.top === Math.max(row.bottom, filters.bottom) + 16;
    }), true);
    await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('button.st-roadmap-icon[aria-haspopup="menu"]'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
