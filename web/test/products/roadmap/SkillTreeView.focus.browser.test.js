import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost();

hostTest('Chromium: Graph Find hands off without replacing the row or losing input focus; G keeps switch focus', async () => {
  const { page, errors } = await openHost();
  try {
    await page.evaluate(() => { window.originalRow = document.querySelector('.st-roadmap-identity'); });
    await page.keyboard.press('/');
    const find = page.getByRole('searchbox');
    await find.fill('wind');
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
    assert.deepEqual(await find.evaluate((input) => [input.value, document.activeElement === input, window.originalRow === document.querySelector('.st-roadmap-identity')]), ['wind', true, true]);
    await find.press('Escape');
    await find.press('Escape');
    await page.locator('.st-board-switch-option[aria-pressed="true"]').focus();
    await page.keyboard.press('g');
    await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'tree');
    assert.equal(await page.locator('.st-board-switch-option[aria-pressed="true"]').evaluate((button) => document.activeElement === button), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_find')), [{ name: 'roadmap_graph_find', props: { step: 'handoff' } }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: row Share, Ask AI and More shortcuts return focus; Export downloads and Settings navigates', async () => {
  const { page, errors } = await openHost();
  try {
    const row = page.locator('.st-roadmap-identity');
    assert.equal(await row.locator('.st-roadmap-switcher [aria-haspopup="menu"]').count(), 1);
    await row.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: 'Share roadmap' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Share');
    await row.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Tell the tree what to change' });
    await prompt.waitFor();
    await prompt.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Ask AI');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
    await row.getByRole('button', { name: 'More', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Export' }).click();
    assert.equal((await download).suggestedFilename(), 'learn-to-sail-sail.md');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_export')), [{ name: 'roadmap_export', props: { outcome: 'done', door: 'more' } }]);
    await row.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.waitForFunction(() => location.pathname === '/app/settings');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const [label, expected] of [['Spanish basics', '#/app/t_other'], ['New roadmap', '#/app/new'], ['Planted in public', '#/browse']]) {
  hostTest(`Chromium: real phone sheet navigates via ${label}`, async () => {
    const { page, errors } = await openHost({ width: 390 });
    try {
      await page.locator('.st-roadmap-title-button').click();
      const sheet = page.getByRole('dialog', { name: 'Roadmap', exact: true });
      await sheet.waitFor();
      assert.deepEqual(await sheet.locator('[aria-current="true"]').evaluate((row) => ({
        title: row.querySelector('.st-roadmap-sheet-tree-name').textContent,
        count: row.querySelector('.st-roadmap-sheet-count').textContent,
      })), { title: 'Learn to sail', count: '1/3' });
      await sheet.getByRole('button', { name: label, exact: label !== 'Spanish basics' }).click();
      await page.waitForFunction((hash) => location.hash === hash, expected);
      assert.equal(await page.getByRole('dialog', { name: 'Roadmap', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const key of ['?', 'Meta+k']) {
  hostTest(`Chromium: ${key} opened from a Board card restores that card rather than a stale row trigger`, async () => {
    const { page, errors } = await openHost({ surface: 'board' });
    try {
      const more = page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true });
      await more.click();
      await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
      await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
      const card = page.locator('.st-board-card[data-step-id="wind"]');
      await card.focus();
      await page.keyboard.press(key);
      if (key === '?') await page.getByRole('dialog').filter({ hasText: 'Keyboard shortcuts' }).waitFor();
      else await page.getByRole('textbox', { name: 'Tell the tree what to change' }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.matches('.st-board-card[data-step-id="wind"]'));
      assert.equal(await card.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: Graph completion Undo returns to its Complete action after unrelated row activity', async () => {
  const { page, errors } = await openHost();
  try {
    await page.evaluate(() => window.scene.select('wind'));
    const complete = page.getByRole('button', { name: 'Complete', exact: true });
    await complete.click();
    await page.locator('.st-graph-toast').waitFor();
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'More', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.locator('.st-board-toast-undo').click();
    await complete.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Complete');
    assert.equal(await complete.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: clipboard refusal emits no successful share beacon or link toast', async () => {
  const { page, errors } = await openHost({ role: 'reader', clipboardRefused: true });
  try {
    const share = page.locator('.st-roadmap-identity').getByRole('button', { name: 'Share', exact: true });
    await share.click();
    await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_graph_toast' && props.act === 'link' && props.outcome === 'failed'));
    assert.deepEqual(await page.evaluate(() => ({
      copies: window.copied,
      shares: window.events.filter(({ name }) => name === 'link_copy'),
      issues: window.issues,
      toasts: window.events.filter(({ name }) => name === 'roadmap_graph_toast'),
    })), { copies: [], shares: [], issues: [], toasts: [{ name: 'roadmap_graph_toast', props: { act: 'link', outcome: 'failed' } }] });
    assert.equal(await share.evaluate((element) => document.activeElement === element), true);
    assert.equal(await page.locator('.st-graph-toast').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the demo Board slash shortcut focuses the displayed demo Find field', async () => {
  const { page, errors } = await openHost({ surface: 'board', demo: true });
  try {
    const find = page.locator('.st-roadmap-identity[data-role="demo"] .st-board-find-input');
    await find.waitFor();
    await page.locator('.st-board-card').first().focus();
    await page.keyboard.press('/');
    assert.equal(await find.evaluate((element) => document.activeElement === element), true);
    await find.fill('wind');
    assert.equal(await find.inputValue(), 'wind');
    assert.equal(await page.locator('.st-roadmap-identity[data-role="demo"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the phone Fork pill restores focus to the pill after dismissal', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader' });
  try {
    const fork = page.getByRole('button', { name: 'Fork this tree', exact: true });
    await fork.click();
    await page.getByRole('heading', { name: 'Make it yours' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Fork this tree');
    assert.equal(await fork.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: phone roadmap sheet receives exact unfiltered state counts from the host', async () => {
  const { page, errors } = await openHost({ width: 390, large: true });
  try {
    await page.locator('.st-roadmap-title-button').click();
    const sheet = page.getByRole('dialog', { name: 'Roadmap', exact: true });
    await sheet.waitFor();
    assert.equal(await sheet.locator('.st-roadmap-sheet-progress').textContent(), '1 done · 1 up next · 998 locked');
    assert.equal(await sheet.locator('[aria-current="true"] .st-roadmap-sheet-count').textContent(), '1/1k');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: empty Board creation cancel returns to the empty-state New step trigger', async () => {
  const { page, errors } = await openHost({ surface: 'board', empty: true });
  try {
    const create = page.locator('.st-view-layer--board').getByRole('button', { name: 'New step', exact: true });
    await create.click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor({ state: 'detached' });
    await create.evaluate((element) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await create.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: tablet Mark not done uses the canon focus ring after keyboard completion', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    const complete = page.getByRole('button', { name: 'Mark done', exact: true });
    await complete.focus();
    await page.keyboard.press('Enter');
    const reset = page.getByRole('button', { name: 'Mark not done', exact: true });
    await reset.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Mark not done');
    assert.deepEqual(await reset.evaluate((element) => {
      const style = getComputedStyle(element);
      const sample = document.createElement('span');
      sample.style.color = 'var(--color-brand)';
      element.append(sample);
      const brand = getComputedStyle(sample).color;
      sample.remove();
      return { focused: element.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle,
        offset: style.outlineOffset, brand: style.outlineColor === brand };
    }), { focused: true, width: '2px', style: 'solid', offset: '2px', brand: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Ask AI dims and covers navigation outside the real shell room', async () => {
  const { page, errors } = await openHost({ shell: true });
  try {
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.getByRole('textbox', { name: 'Tell the tree what to change' }).waitFor();
    assert.deepEqual(await page.locator('.st-tend-overlay').evaluate((overlay) => {
      const rect = overlay.getBoundingClientRect();
      const head = document.querySelector('.wm-head').getBoundingClientRect();
      return {
        parent: overlay.parentElement.className,
        frame: [rect.left, rect.top, rect.right, rect.bottom],
        viewport: [0, 0, window.innerWidth, window.innerHeight],
        dims: getComputedStyle(overlay).backgroundColor !== 'rgba(0, 0, 0, 0)',
        coversNavigation: document.elementFromPoint(head.left + head.width / 2, head.top + head.height / 2) === overlay,
      };
    }), { parent: 'wm-shell', frame: [0, 0, 1440, 1000], viewport: [0, 0, 1440, 1000], dims: true, coversNavigation: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 744, 1024, 1440]) {
  hostTest(`Chromium: Fork uses approved presentation and returns to its opener at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      const label = width === 390 ? 'Fork this tree' : 'Fork';
      const opener = page.getByRole('button', { name: label, exact: true });
      await opener.click();
      await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Make it yours' }) }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction((label) => document.activeElement?.getAttribute('aria-label') === label || document.activeElement?.textContent?.trim() === label, label);
      assert.equal(await opener.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [744, 1440]) {
  hostTest(`Chromium: Enter Escape G G keeps the hidden Graph dock out of Tab at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await page.locator('.st-board-card[data-step-id="wind"]').focus();
      await page.keyboard.press('Enter');
      await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
      await page.keyboard.press('g');
      await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'tree');
      assert.equal(await page.locator('.st-view-layer--board').evaluate((layer) => layer.inert), true);
      await page.keyboard.press('g');
      await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
      assert.deepEqual(await page.locator('.st-detail-panel').evaluateAll((layers) => layers.map((layer) => layer.inert)), [true]);
      assert.equal(await page.locator('.st-view-layer--board').evaluate((layer) => layer.inert), false);
      const card = page.locator('.st-board-card').last();
      await card.focus();
      for (let index = 0; index < 8; index += 1) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.st-detail-panel, [inert]'))), false);
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [390, 744, 1440]) for (const dismissal of [null, 'Escape', 'scrim']) {
  hostTest(`Chromium: Ask AI closes on submit and restores its failed sentence ${dismissal ? `after ${dismissal} dismissal` : 'on failure'} at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      const { runFace } = await import('../../../src/products/roadmap/tending/receipts.js');
      let failed = true;
      let finish;
      let started;
      const requestStarted = new Promise((resolve) => { started = resolve; });
      await page.route('**/v1/trees/t_sail/tend', async (route) => {
        if (failed) {
          await new Promise((resolve) => { finish = resolve; started(); });
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'failed' }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'done', edits: 0 }) });
      });
      const openAskAI = async () => {
        if (width === 390) {
          await page.locator('.st-roadmap-title-button').click();
          await page.getByRole('dialog', { name: 'Roadmap', exact: true }).getByRole('button', { name: 'Ask AI', exact: true }).click();
        } else if (width === 744) {
          await page.getByRole('button', { name: 'More', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Ask AI', exact: true }).click();
        } else {
          await page.locator('.st-roadmap-identity').getByRole('button', { name: 'Ask AI', exact: true }).click();
        }
        await page.locator('.st-tend-overlay').waitFor();
      };
      await openAskAI();
      const input = page.getByRole('textbox', { name: 'Tell the tree what to change' });
      const sentence = '  Add a practice step  ';
      await input.fill(sentence);
      await input.press('Enter');
      await requestStarted;
      await page.locator('.st-tend-overlay').waitFor({ state: 'detached' });
      if (dismissal) {
        await openAskAI();
        assert.equal(await page.locator('.st-tend-overlay').getByText('Updating roadmap…', { exact: true }).count(), 1);
        if (dismissal === 'Escape') await page.keyboard.press('Escape');
        else await page.locator('.st-tend-overlay').click({ position: { x: 4, y: 4 } });
        await page.locator('.st-tend-overlay').waitFor({ state: 'detached' });
      }
      finish();
      await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_verb' && props.verb === 'askAI' && props.outcome === 'failed'));
      if (dismissal) {
        assert.equal(await page.locator('.st-tend-overlay').count(), 0);
        await openAskAI();
      }
      await input.waitFor();
      assert.equal(await input.inputValue(), sentence);
      const failureLine = runFace({ status: 'failed' }).line;
      assert.equal(await page.locator('.st-toast-row').getByText(failureLine, { exact: true }).count(), 1);
      const announcement = page.locator('.st-tend-overlay [role="status"]');
      assert.deepEqual(await announcement.evaluate((element) => ({
        text: element.textContent, live: element.getAttribute('aria-live'), atomic: element.getAttribute('aria-atomic'),
        inDialog: Boolean(element.closest('[role="dialog"]')), inert: Boolean(element.closest('[inert]')),
        describesInput: element.closest('form').querySelector('input').getAttribute('aria-describedby') === element.id,
      })), { text: failureLine, live: 'polite', atomic: 'true', inDialog: true, inert: false, describesInput: true });
      await page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
      failed = false;
      await input.press('Enter');
      await page.locator('.st-tend-overlay').waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_verb' && props.verb === 'askAI' && props.outcome === 'receipt'));
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_verb' && props.verb === 'askAI' && props.step)), [
        { name: 'roadmap_verb', props: { verb: 'askAI', step: 'send' } },
        { name: 'roadmap_verb', props: { verb: 'askAI', step: 'answer', outcome: 'failed' } },
        { name: 'roadmap_verb', props: { verb: 'askAI', step: 'send' } },
        { name: 'roadmap_verb', props: { verb: 'askAI', step: 'answer', outcome: 'receipt' } },
      ]);
      await openAskAI();
      assert.equal(await input.inputValue(), '');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
