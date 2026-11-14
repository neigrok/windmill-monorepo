import assert from 'node:assert/strict';
import { hostTest, openHost, origin, startRoadmapHost } from './skillTreeViewHost.js';
import { LINK_COPIED, STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

hostTest('Chromium: Next only selects and reveals; Enter opens its document with inline Undo', async () => {
  const { page, errors } = await openHost();
  try {
    await page.getByRole('button', { name: 'Next · 1', exact: true }).click();
    await page.getByRole('dialog', { name: '1 up next' }).locator('.st-roadmap-next-card').filter({ hasText: 'Read the wind' }).click();
    assert.deepEqual(await page.evaluate(() => [window.revealed.at(-1), document.activeElement?.textContent]), ['wind', 'Next · 1']);
    assert.equal(await page.locator('article').count(), 0);
    await page.locator('canvas[data-graph-focus]').focus();
    await page.keyboard.press('Enter');
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), true);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Graph create reveals the step and Undo removes only that create', async () => {
  const { page, errors } = await openHost();
  try {
    const create = page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true });
    await create.click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Practice knots');
    await page.getByRole('button', { name: 'Create step', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    assert.equal(await page.locator('.st-roadmap-progress').getAttribute('aria-label'), '1 of 4 steps done');
    const created = await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ label }) => label === 'Practice knots').id);
    await page.waitForFunction((id) => window.revealFrames.at(-1)?.id === id, created);
    assert.deepEqual(await page.evaluate(() => {
      const frame = window.revealFrames.at(-1);
      return { id: frame.id, installed: frame.installed, right: frame.insets.right };
    }), { id: created, installed: true, right: 24 });
    const previousReveals = await page.evaluate(() => window.revealed.length);
    await page.locator('.st-board-toast-message').click();
    await page.waitForFunction((previous) => window.revealed.length > previous, previousReveals);
    assert.equal(await page.evaluate(() => window.revealed.at(-1)), created);
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 3 steps done');
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.map(({ id }) => id).sort()), ['course', 'dock', 'wind']);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'New step');
    assert.equal(await create.evaluate((element) => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: completion in the shared document stays quiet and reader Share/Fork reach their doors', async () => {
  const owner = await openHost({ milestone: true });
  try {
    await owner.page.evaluate(() => window.scene.activate('dock'));
    await owner.page.getByRole('button', { name: 'Complete', exact: true }).click();
    assert.equal(await owner.page.evaluate(() => window.session.progress.overlay().completed.has('dock')), true);
    assert.deepEqual(await owner.page.evaluate(() => window.ceremonies), []);
    assert.deepEqual(owner.errors, []);
  } finally { await owner.page.close(); }
  const reader = await openHost({ role: 'reader' });
  try {
    await reader.page.getByRole('button', { name: 'Share', exact: true }).click();
    await reader.page.locator('.st-graph-toast').waitFor();
    assert.equal(await reader.page.locator('.st-board-toast-message').textContent(), 'Link copied');
    assert.deepEqual(await reader.page.evaluate(() => window.copied), [`${origin}/t/t_sail`]);
    await reader.page.getByRole('button', { name: 'Fork', exact: true }).click();
    await reader.page.getByRole('heading', { name: 'Make it yours' }).waitFor();
    await reader.page.keyboard.press('Escape');
    await reader.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Fork');
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
});

for (const width of [744, 1440]) {
  hostTest(`Chromium: the Graph camera keeps its full canvas after selection at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.locator('article, .st-detail-panel--open').count(), 0);
      const camera = await page.locator('.st-graph-camera').evaluate((element) => ({
        right: Number.parseFloat(element.style.right), bottom: Number.parseFloat(element.style.bottom),
        width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
      }));
      const insets = await page.evaluate(() => window.cameraInsets);
      assert.deepEqual(camera, { right: Math.max(24, insets.right), bottom: Math.max(24, insets.bottom), width: 248, height: 50 });
      assert.deepEqual(insets.blocks.at(-1), { right: camera.right, bottom: camera.bottom, width: 248, height: 50 });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [744, 1024, 1280, 1440]) {
  for (const ceremony of [true]) {
    hostTest(`Chromium: Graph ${ceremony ? 'ceremony' : 'completion'} toast keeps its drawn width and clears panel, minimap and camera at ${width}px`, async () => {
      const { page, errors } = await openHost({ width, height: 900, legend: true });
      try {
        await page.evaluate(() => document.fonts.ready);
        const time = new Date('2026-11-03T12:00:00Z');
        await page.clock.install({ time: new Date(time.getTime() - 60000) });
        await page.clock.pauseAt(time);
        await page.evaluate(() => window.scene.select('wind'));
        assert.equal(await page.locator('.st-detail-panel--open').count(), 0);
        await page.clock.runFor(300);
        if (ceremony) {
          await page.evaluate(() => window.scene.options.onCeremonyToast('Read the wind done · Leave the dock up next'));
        } else {
          await page.getByRole('button', { name: width < 1024 ? 'Mark done' : 'Complete', exact: true }).click();
          await page.locator('.st-graph-toast').waitFor();
        }
        await page.clock.runFor(300);
        const selector = '.st-graph-toast .st-board-toast';
        await page.locator(selector).waitFor();
        await page.waitForFunction((selector) => {
          const toast = document.querySelector(selector).getBoundingClientRect();
          return [...document.querySelectorAll('.st-graph-camera, .st-minimap, .st-legend-dock, .st-detail-panel--open')]
            .filter((element) => element.getClientRects().length > 0)
            .every((element) => {
              const obstacle = element.getBoundingClientRect();
              return toast.right <= obstacle.left || toast.left >= obstacle.right || toast.bottom <= obstacle.top || toast.top >= obstacle.bottom;
            });
        }, selector);
        const geometry = await page.locator(selector).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const message = element.querySelector('.st-board-toast-message');
          const range = document.createRange();
          range.selectNodeContents(message);
          return { inCanvas: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
            lines: range.getClientRects().length, message: message.textContent };
        });
        assert.equal(geometry.inCanvas, true);
        assert.equal(geometry.lines, 1);
        assert.equal(geometry.message, 'Read the wind done · Leave the dock up next');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: tablet read-only Graph legend names its non-interactive swatches by kind', async () => {
  const { page, errors } = await openHost({ width: 744, role: 'reader', legend: true });
  try {
    const legend = page.locator('.st-legend-dock');
    await legend.waitFor();
    assert.deepEqual(await legend.locator('[role="img"]').evaluateAll((elements) => elements.map((element) => ({
      tag: element.tagName, name: element.getAttribute('aria-label'), tabIndex: element.tabIndex,
    }))), [{ tag: 'SPAN', name: 'Build', tabIndex: -1 }, { tag: 'SPAN', name: 'Learn', tabIndex: -1 }]);
    assert.equal(await legend.locator('button:not([aria-label])').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: phone Graph toast clears the camera after selecting a step for both roles', async () => {
  for (const role of ['reader', 'owner']) {
    const { page, errors } = await openHost({ width: 390, role });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      assert.equal(await page.locator('[data-graph-step-bar]').count(), 0);
      await page.evaluate(() => window.scene.options.onCeremonyToast('A roadmap update'));
      await page.locator('.st-graph-toast .st-board-toast').waitFor();
      await page.waitForFunction(() => {
        const toast = document.querySelector('.st-graph-toast .st-board-toast').getBoundingClientRect();
        const camera = document.querySelector('.st-view-actions').getBoundingClientRect();
        return toast.top >= camera.bottom && toast.bottom <= innerHeight;
      });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

hostTest('Chromium: the demo coach leaves Escape to the document above it', async () => {
  const { page, errors } = await openHost({ width: 390, role: 'reader', demo: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    const step = page.getByRole('article', { name: 'Read the wind', exact: true });
    await step.waitFor();
    await page.keyboard.press('Escape');
    await step.waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-graph-step-bar]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a room toast over the phone step page stands above its pinned actions', async () => {
  const { page, errors } = await openHost({ width: 390, surface: 'board' });
  try {
    await page.locator('.st-board-phone-pane.is-shown .st-board-card[data-step-id="wind"]').click();
    await page.locator('.st-board-step-layer article').waitFor();
    await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.copyLink, exact: true }).click();
    const toast = page.locator('.st-graph-toast .st-board-toast');
    await toast.waitFor();
    assert.equal(await toast.locator('.st-board-toast-message').textContent(), LINK_COPIED);
    assert.deepEqual(await page.evaluate(() => {
      const box = document.querySelector('.st-graph-toast .st-board-toast').getBoundingClientRect();
      return [...document.querySelectorAll('.st-step-pinned-actions')].map((tabs) => box.bottom <= tabs.getBoundingClientRect().top);
    }), [true]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Graph legend and selection labels use the shared Recolor copy', async () => {
  const { RECOLOR } = await import('../../../src/products/roadmap/copy.js');
  const { page, errors } = await openHost({ width: 1440, legend: true, broad: true });
  try {
    const legend = page.locator('.st-legend-dock');
    await legend.waitFor();
    assert.deepEqual(await legend.locator('button[aria-label]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      ['Build', 'Learn', 'Sky'].map(RECOLOR.kind));
    await page.evaluate(() => window.scene.options.onSelectionToggle('knots'));
    assert.equal(await page.locator('.st-detail-panel--open').count(), 0);
    await page.evaluate(() => window.scene.options.onSelectionToggle('dock'));
    const selection = page.locator('.st-selection-bar');
    await selection.waitFor();
    assert.equal(await selection.getByRole('group').getAttribute('aria-label'), RECOLOR.steps);
    assert.deepEqual(await selection.locator('.st-step-swatch').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      ['Build', 'Learn', 'Gold', 'Brick', 'Sky', 'Plum'].map(RECOLOR.selection));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
