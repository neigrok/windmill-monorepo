import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, COMPOSER, DELETE_CONFIRM, EDIT_STEP, EMPTY_ROADMAP, GRAPH_UNAVAILABLE, LABELS, ROADMAP_SHEET, ROADMAP_VERBS, STEP_DETAIL, VIEW_SWITCH, deletedToast, progressLabel } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

for (const width of [1440, 1024, 744, 390]) {
  for (const options of [{ role: 'reader', address: '/t/' }, { role: 'reader', demo: true, address: '#/demo' }]) {
    hostTest(`Chromium: no WebGL2 opens ${options.demo ? 'demo' : 'reader /t/'} on Board at ${width}`, async () => {
      const { page, errors } = await openHost({ ...options, width, noWebgl2: true });
      try {
        await page.locator('.st-roadmap-identity[data-view="board"]').waitFor();
        const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
        assert.deepEqual(await graph.evaluate((button) => ({
          opacity: getComputedStyle(button).opacity, disabled: button.getAttribute('aria-disabled'), pressed: button.getAttribute('aria-pressed'),
          description: document.getElementById(button.getAttribute('aria-describedby')).textContent,
          name: button.getAttribute('aria-label'), tabIndex: button.tabIndex,
        })), { opacity: '0.45', disabled: 'true', pressed: 'false', description: GRAPH_UNAVAILABLE, name: VIEW_SWITCH.graph, tabIndex: 0 });
        const board = page.getByRole('button', { name: VIEW_SWITCH.board, exact: true });
        await board.focus();
        await page.keyboard.press('Tab');
        assert.equal(await graph.evaluate((button) => button === document.activeElement), true);
        assert.equal(await board.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await page.evaluate(() => ({ seen: window.graphIdentitySeen, attempts: window.sceneAttempts, scene: !!window.scene, issues: window.issues })),
          { seen: false, attempts: 1, scene: false, issues: [] });
        const band = width < 744 ? 'phone' : width < 1024 ? 'tablet' : 'desktop';
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => ['webgl_init_fail', 'roadmap_view_open'].includes(name))), [
          { name: 'webgl_init_fail', props: { band } },
          { name: 'roadmap_view_open', props: { view: 'board', band, role: options.demo ? 'demo' : 'reader', door: 'no_graph' } },
        ]);
        assert.equal(await page.locator('.st-graph-toast, .st-loading').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const options of [{ address: '#/t/', role: 'reader' }, { address: '?view', role: 'reader' }, { born: true }, { surface: 'tree' }, { surface: 'board' }]) {
  hostTest(`Chromium: no WebGL2 preserves saved preference and handles ${JSON.stringify(options)}`, async () => {
    const { page, errors } = await openHost({ noWebgl2: true, ...options });
    try {
      await page.locator('.st-roadmap-identity[data-view="board"]').waitFor();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:view:last')).t_sail), options.surface ?? 'tree');
      await page.keyboard.press('g');
      await page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true }).press('Enter');
      assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'board');
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_view_switch')), []);
      const door = options.surface === 'board' ? 'saved' : 'no_graph';
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_view_open').map(({ props }) => props.door)), [door]);
      assert.deepEqual(await page.evaluate(() => window.issues), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [1440, 1024, 744]) {
  hostTest(`Chromium: unavailable Graph tooltip opens and dismisses through every door at ${width}`, async () => {
    const { page, errors } = await openHost({ width, noWebgl2: true });
    try {
      const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
      const tooltip = page.locator('.st-graph-unavailable-reason');
      assert.equal(await tooltip.getAttribute('hidden'), '');
      await graph.hover();
      await tooltip.waitFor({ state: 'visible' });
      assert.equal(await tooltip.textContent(), GRAPH_UNAVAILABLE);
      assert.deepEqual(await tooltip.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { inside: box.left >= 0 && box.right <= innerWidth, width: box.width, role: element.getAttribute('role') };
      }), { inside: true, width: 292, role: 'tooltip' });
      await page.mouse.move(width - 2, 500);
      await tooltip.waitFor({ state: 'hidden' });
      await graph.focus();
      await tooltip.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await tooltip.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: VIEW_SWITCH.board, exact: true }).focus();
      await graph.focus();
      await tooltip.waitFor({ state: 'visible' });
      await page.getByRole('button', { name: VIEW_SWITCH.board, exact: true }).focus();
      await tooltip.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_unavailable')), []);
      await graph.click({ force: true });
      await tooltip.waitFor({ state: 'visible' });
      await page.mouse.click(width - 2, 500);
      await tooltip.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_unavailable')),
        [{ name: 'roadmap_graph_unavailable', props: { band: width < 1024 ? 'tablet' : 'desktop' } }]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [1440, 1024, 744, 390]) {
  hostTest(`Chromium: Graph doors close while surviving Activity stays usable at ${width}`, async () => {
    const { page, errors } = await openHost({ width, noWebgl2: true });
    try {
      await page.locator('.st-board-card[data-step-id="wind"]').click();
      await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
      await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
      assert.equal(await page.getByRole('menuitem', { name: STEP_DETAIL.openInGraph, exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
      await page.keyboard.press('a');
      if (width >= 1024) {
        assert.equal(await page.locator('.st-roadmap-activity-panel, .st-detail-panel--open .st-activity').count(), 0);
        await page.getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
        assert.equal(await page.getByRole('menuitem', { name: ROADMAP_VERBS.activity, exact: true }).count(), 0);
      } else if (width === 744) {
        await page.locator('.st-roadmap-activity-panel').waitFor();
      } else {
        await page.locator('.st-roadmap-title-button').click();
        await page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true }).getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
        await page.getByRole('dialog', { name: ACTIVITY.heading, exact: true }).waitFor();
      }
      assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'board');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: no WebGL2 Board crash keeps the Reload fallback and reports roadmap-board', async () => {
  const { page, errors } = await openHost({ noWebgl2: true, crashBoard: true });
  try {
    await page.getByRole('button', { name: 'Reload', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.issues), [{ operation: 'roadmap-board', stack: true }]);
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'board');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: an empty reader without WebGL2 sees the identity without owner onboarding', async () => {
  const { page, errors } = await openHost({ noWebgl2: true, role: 'reader', empty: true });
  try {
    assert.equal(await page.locator('.st-roadmap-progress').getAttribute('aria-label'), progressLabel({ done: 0, total: 0 }));
    assert.equal(await page.getByText(EMPTY_ROADMAP.title, { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: LABELS.newStep, exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: phone Graph reason uses the toast slot without replacing a held delete', async () => {
  const { page, errors } = await openHost({ width: 390, noWebgl2: true, fixedClock: true, touch: true });
  try {
    const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
    await graph.tap({ force: true });
    await page.clock.runFor(200);
    await page.locator('.st-board-toast-message').filter({ hasText: GRAPH_UNAVAILABLE }).waitFor();
    assert.equal(await page.locator('.st-board-toast button').count(), 0);
    await page.clock.runFor(4500);
    await page.locator('.st-board-toast').waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /^Locked,/ }).click();
    await page.locator('.st-board-card[data-step-id="dock"]').click();
    await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).waitFor();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.clock.runFor(800);
    const toast = page.locator('.st-board-toast');
    await page.locator('.st-board-toast-message').filter({ hasText: deletedToast({ step: 'Leave the dock' }) }).waitFor();
    const before = await toast.innerHTML();
    await graph.tap({ force: true });
    assert.equal(await toast.innerHTML(), before);
    assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock')), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_board_delete' && props.via === 'replaced')), []);
    await page.locator('.st-board-toast-undo').click();
    await page.clock.runFor(800);
    await page.locator('.st-board-card[data-step-id="dock"]').waitFor({ state: 'attached' });
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_unavailable')), [
      { name: 'roadmap_graph_unavailable', props: { band: 'phone' } },
      { name: 'roadmap_graph_unavailable', props: { band: 'phone' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a scene-less owner can complete, Undo, create and edit', async () => {
  const { page, errors } = await openHost({ noWebgl2: true });
  try {
    await page.locator('.st-board-card[data-step-id="wind"]').focus();
    await page.keyboard.press('c');
    await page.locator('.st-board-toast-undo').waitFor();
    await page.locator('.st-board-toast-undo').click();
    await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 3 steps done');
    await page.getByRole('button', { name: LABELS.newStep, exact: true }).first().click();
    await page.getByRole('textbox', { name: COMPOSER.name, exact: true }).fill('Practice knots');
    await page.getByRole('button', { name: COMPOSER.create, exact: true }).click();
    await page.locator('.st-board-card-title').filter({ hasText: 'Practice knots' }).waitFor();
    await page.locator('.st-board-toast-undo').click();
    await page.locator('.st-board-card-title').filter({ hasText: 'Practice knots' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.some(({ label }) => label === 'Practice knots')), false);
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
    await page.getByRole('textbox', { name: COMPOSER.name, exact: true }).fill('Read gusts');
    await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
    await page.getByRole('dialog', { name: 'Read gusts', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


hostTest('Chromium: other constructor errors keep the existing render-boundary path', async () => {
  const { page, errors } = await openHost({ sceneFailure: true });
  try {
    assert.equal(await page.getByRole('button', { name: 'Reload', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.reportedErrors), ['Error: Fixture renderer construction failure']);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'webgl_init_fail')), []);
    assert.equal(await page.locator('.st-board').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: unavailable scene never retries after a band change and the identity fallback keeps its reason', async () => {
  const { page, errors } = await openHost({ noWebgl2: true, crash: true, width: 1440 });
  try {
    await page.locator('.st-roadmap-identity-fallback').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
    await page.locator('.st-board-switch--phone').waitFor();
    await graph.click({ force: true });
    await page.locator('.st-board-toast-message').filter({ hasText: GRAPH_UNAVAILABLE }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({ attempts: window.sceneAttempts, failures: window.events.filter(({ name }) => name === 'webgl_init_fail') })), {
      attempts: 1, failures: [{ name: 'webgl_init_fail', props: { band: 'desktop' } }],
    });
    assert.deepEqual(await page.evaluate(() => window.issues), [{ operation: 'roadmap-identity', stack: true }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


hostTest('Chromium: scene-less committed deletion updates the Board projection', async () => {
  const { page, errors } = await openHost({ noWebgl2: true, fixedClock: true });
  try {
    await page.locator('.st-board-card[data-step-id="dock"]').focus();
    await page.keyboard.press('Delete');
    await page.clock.runFor(800);
    await page.locator('.st-board-toast-message').filter({ hasText: deletedToast({ step: 'Leave the dock' }) }).waitFor();
    assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock')), true);
    await page.clock.runFor(11000);
    await page.waitForFunction(() => !window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock'));
    assert.equal(await page.locator('.st-board-card[data-step-id="dock"]').count(), 0);
    assert.equal(await page.locator('.st-roadmap-progress').getAttribute('aria-label'), progressLabel({ done: 1, total: 2 }));
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
