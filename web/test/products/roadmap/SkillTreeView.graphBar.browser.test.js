import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { DELETE_CONFIRM, EDIT_STEP, FORK_OFFER, OPEN_STEP, STEP_DETAIL, backTo, deletedToast } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('graphBar');

for (const width of [320, 390]) {
  for (const role of ['owner', 'reader', 'demo']) {
    for (const theme of ['light', 'dark']) {
      hostTest(`Chromium: Graph bar ${role} at ${width}px in ${theme} opens its step and returns to its primary`, async () => {
        const { page, errors } = await openHost({ width, role: role === 'demo' ? 'reader' : role, demo: role === 'demo' });
        try {
          await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
          await page.evaluate(() => window.scene.select('wind'));
          const bar = page.locator('[data-graph-step-bar]');
          await bar.waitFor();
          const palette = await bar.evaluate((element) => {
            const selected = document.documentElement.dataset.theme;
            const background = getComputedStyle(element).backgroundColor;
            document.documentElement.dataset.theme = selected === 'dark' ? 'light' : 'dark';
            const other = getComputedStyle(element).backgroundColor;
            document.documentElement.dataset.theme = selected;
            return { selected, background, other };
          });
          assert.equal(palette.selected, theme);
          assert.notEqual(palette.background, palette.other);
          assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), role === 'owner' ? OPEN_STEP : FORK_OFFER);
          assert.equal(await page.locator('.st-step-name, .st-aim-bar, .st-remove-link-bar, .st-bulk-bar').count(), 0);
          if (role === 'owner') assert.deepEqual(await page.evaluate(() => [window.longPress, window.editTap]), [null, null]);
          await page.waitForFunction(() => window.cameraInsets.bottom >= document.querySelector('[data-graph-step-bar]').getBoundingClientRect().height + 12);
          const before = await page.evaluate(() => window.scene.getViewpoint());
          if (role === 'owner') await bar.getByRole('button', { name: OPEN_STEP, exact: true }).click();
          else await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
          await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
          assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'tree');
          assert.equal(await page.locator('canvas.st-canvas').evaluate((element) => element.inert), true);
          assert.equal(await page.locator('.st-roadmap-identity-host').evaluate((element) => element.inert), true);
          await page.getByRole('button', { name: backTo({ screen: 'Learn to sail' }), exact: true }).click();
          await bar.waitFor();
          await page.waitForFunction(() => document.activeElement?.hasAttribute('data-graph-step-primary'));
          assert.deepEqual(await page.evaluate(() => window.scene.getViewpoint()), before);
          assert.equal(await bar.locator('.st-graph-step-title').textContent(), 'Read the wind');
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
}

hostTest('Chromium: Graph detail edits through the composer and held delete Undo targets that step', async () => {
  const { page, errors } = await openHost({ width: 390, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
    await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
    await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
    await page.getByRole('dialog', { name: 'Read gusts', exact: true }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.clock.runFor(300);
    await page.locator('.st-graph-toast').waitFor();
    await page.waitForFunction(() => !window.scene.nodesById.has('wind'));
    assert.equal(await page.locator('.st-board-toast-message').textContent(), deletedToast({ step: 'Read gusts' }));
    await page.locator('.st-board-toast-undo').click();
    await page.clock.runFor(300);
    await page.locator('[data-graph-step-bar]').waitFor();
    assert.equal(await page.locator('.st-graph-step-title').textContent(), 'Read gusts');
    assert.equal(await page.evaluate(() => window.scene.nodesById.has('wind')), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: bar Fork returns focus and deselection deliberately focuses the pressed switch', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader' });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    const primary = page.locator('[data-graph-step-primary]');
    await primary.click();
    await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-graph-step-primary'));
    await page.evaluate(() => window.scene.select(null));
    await primary.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.st-board-switch-option[aria-pressed="true"]'));
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_verb' && props.door === 'bar')), [
      { name: 'roadmap_verb', props: { verb: 'fork', door: 'bar', view: 'graph', band: 'phone' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [320, 390]) {
  hostTest(`Chromium: Graph BoardToast clears a selected bar at ${width}px during a held delete`, async () => {
    const { page, errors } = await openHost({ width, role: 'owner', fixedClock: true });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
      await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
      await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
      await page.clock.runFor(300);
      await page.locator('.st-graph-toast .st-board-toast').waitFor();
      await page.evaluate(() => window.scene.select('course'));
      await page.clock.runFor(300);
      await page.locator('[data-graph-step-bar]').waitFor();
      assert.equal(await page.evaluate(() => {
        const bar = document.querySelector('[data-graph-step-bar]').getBoundingClientRect();
        const toast = document.querySelector('.st-graph-toast .st-board-toast').getBoundingClientRect();
        return toast.bottom <= bar.top;
      }), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: unnamed Graph steps share the detail title rule for owner and reader', async () => {
  for (const role of ['owner', 'reader']) {
    const { page, errors } = await openHost({ width: 390, role });
    try {
      await page.evaluate(() => {
        window.session.dispatch({ kind: 'RenameNode', id: 'wind', label: '   ' });
        window.scene.select('wind');
      });
      const title = page.locator('.st-graph-step-title');
      await title.waitFor();
      assert.equal(await title.textContent(), STEP_DETAIL.unnamed);
      if (role === 'reader') {
        await page.getByRole('button', { name: STEP_DETAIL.unnamed, exact: true }).click();
        await page.getByRole('dialog', { name: STEP_DETAIL.unnamed, exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

for (const [role, surface, items] of [
  ['owner', 'tree', ['Copy link', 'Delete step']],
  ['reader', 'tree', ['Copy link']],
  ['reader', 'board', ['Copy link', 'Open in Graph']],
  ['owner', 'board', ['Copy link', 'Open in Graph', 'Delete step']],
]) {
  hostTest(`Chromium: the ${role}'s step page over the ${surface === 'tree' ? 'Graph' : 'Board'} offers ${items.join(', ')}`, async () => {
    const { page, errors } = await openHost({ width: 390, role, surface });
    try {
      if (surface === 'tree') {
        await page.evaluate(() => window.scene.select('wind'));
        await page.getByRole('button', { name: role === 'owner' ? OPEN_STEP : 'Read the wind', exact: true }).click();
      } else {
        await page.locator('.st-board-card[data-step-id="wind"]').click();
      }
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
      assert.deepEqual(await page.getByRole('menuitem').allTextContents(), items);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: the demo\'s step page over the Graph has no menu to open, and its menu returns over the Board', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader', demo: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: 'Read the wind', exact: true }).click();
    const step = page.getByRole('dialog', { name: 'Read the wind', exact: true });
    await step.waitFor();
    assert.equal(await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).count(), 0);
    await page.getByRole('button', { name: backTo({ screen: 'Learn to sail' }), exact: true }).click();
    await step.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await step.waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in Graph']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
