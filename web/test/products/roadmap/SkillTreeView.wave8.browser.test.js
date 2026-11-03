import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, EDIT_STEP, FORK_OFFER, OPEN_STEP, ROADMAP_VERBS, STEP_DETAIL, backTo, deletedToast } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('wave8');

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
    await page.getByRole('button', { name: STEP_DETAIL.deleteStep, exact: true }).click();
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

for (const width of [744, 1024, 1440]) {
  for (const surface of ['board', 'tree']) {
    hostTest(`Chromium: Activity A and More use the ${width}px destination from ${surface}`, async () => {
      const { page, errors } = await openHost({ width, surface });
      try {
        await page.keyboard.press('a');
        const feed = page.locator(width === 744 ? '.st-roadmap-activity-panel' : '.st-detail-panel--open .st-activity');
        await feed.waitFor();
        assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), width === 744 ? surface : 'tree');
        await page.keyboard.press('Escape');
        await feed.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'More');
        await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
        await page.getByRole('menuitem', { name: ROADMAP_VERBS.activity }).click();
        await feed.waitFor();
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: P4 reports with the gate closed while Board events and surfaces stay absent', async () => {
  const { page, errors } = await openHost({ gate: 'closed' });
  try {
    await page.evaluate(() => {
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      for (const frameId of ['first', 'second']) {
        session.inFlight.set(frameId, session.lattice.frontier());
        session.receiveReject({ frameId, code: 'server-error' });
      }
    });
    await page.waitForFunction(() => window.issues.length === 1);
    assert.deepEqual(await page.evaluate(() => window.issues), [{ operation: 'roadmap-sync-refused', stack: true, tags: { code: 'server-error' } }]);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => ['roadmap_view_open', 'roadmap_sync_refused'].includes(name))), []);
    assert.equal(await page.locator('.st-roadmap-identity, [data-graph-step-bar]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

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


hostTest('Chromium: empty tablet Activity uses shipped copy, shrinks, and leaves the Board usable', async () => {
  const { page, errors } = await openHost({ width: 744, empty: true, surface: 'board' });
  try {
    await page.keyboard.press('a');
    const panel = page.locator('.st-roadmap-activity-panel');
    await panel.waitFor();
    assert.equal(await panel.locator('.st-activity-empty').textContent(), ACTIVITY.empty);
    assert.equal(await page.locator('.st-view-layer--board').evaluate((element) => element.inert), false);
    assert.deepEqual(await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, right: innerWidth - bounds.right, top: bounds.top, shrunk: bounds.height < 200 };
    }), { width: 320, right: 16, top: 172, shrunk: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
