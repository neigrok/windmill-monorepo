import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { DELETE_CONFIRM, STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

for (const width of [320, 390, 744, 1024, 1440]) {
  for (const role of ['owner', 'reader', 'demo']) {
    hostTest(`Chromium: explicit Graph activation opens one ${role} document at ${width}px and closes to its canvas`, async () => {
      const { page, errors } = await openHost({ width, role: role === 'demo' ? 'reader' : role, demo: role === 'demo' });
      try {
        await page.evaluate(() => window.scene.select('wind'));
        assert.equal(await page.locator('article, [data-graph-step-bar], .st-detail-panel--open').count(), 0);
        const before = await page.evaluate(() => window.scene.getViewpoint());
        await page.evaluate(() => window.scene.activate('wind'));
        const step = page.getByRole('article', { name: 'Read the wind', exact: true });
        await step.waitFor();
        assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail?step=wind');
        assert.equal(await page.locator('.st-product-canvas').evaluate((element) => element.inert), true);
        assert.equal(await step.getAttribute('aria-modal'), null);
        assert.equal(await step.getByRole('tablist').count(), 0);
        assert.equal(await page.locator('.st-board-workspace').count(), role === 'owner' ? 1 : 0);
        await step.focus();
        await page.keyboard.press('Escape');
        await step.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.matches('canvas[data-graph-focus]'));
        assert.deepEqual(await page.evaluate(() => window.scene.getViewpoint()), before);
        assert.equal(await page.locator('.st-product-canvas').evaluate((element) => element.inert), false);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: Enter belongs to the selected Graph canvas; Shell and Coach retain their own keyboard', async () => {
  const { page, errors } = await openHost({ width: 1440, shell: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.locator('canvas[data-graph-focus]').focus();
    await page.keyboard.press('Enter');
    const step = page.getByRole('article', { name: 'Read the wind', exact: true });
    await step.waitFor();
    const coach = page.getByRole('button', { name: 'Collapse Coach' });
    await coach.focus();
    await page.keyboard.press('Escape');
    assert.equal(await step.count(), 1);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Expand Coach' }).waitFor();
    assert.equal(await page.locator('.wm-shell').evaluate((shell) => shell.closest('[inert]') === null), true);
    assert.equal(await page.locator('article').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Graph document keeps the complete edit contract and held delete Undo never reopens it', async () => {
  const { page, errors } = await openHost({ width: 390, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await page.getByRole('article', { name: 'Read gusts', exact: true }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.deleteStep, exact: true }).click();
    await page.getByRole('button', { name: DELETE_CONFIRM.delete, exact: true }).click();
    await page.clock.runFor(300);
    await page.waitForFunction(() => !window.scene.nodesById.has('wind'));
    await page.locator('.st-board-toast-undo').click();
    await page.clock.runFor(300);
    assert.equal(await page.evaluate(() => window.scene.nodesById.has('wind')), true);
    assert.equal(await page.locator('article').count(), 0);
    assert.equal(await page.evaluate(() => location.hash.includes('step=')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: tablet Connect leaves the document for the existing aim tool, and Add step retains blank-name handoff', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => window.editTap(10, 10, 'wind'));
    await page.getByRole('article', { name: 'Read the wind' }).waitFor();
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
    await page.getByRole('group', { name: 'Choose a step' }).waitFor();
    assert.equal(await page.locator('article').count(), 0);
    await page.getByRole('button', { name: 'Cancel connect' }).click();
    await page.evaluate(() => window.editTap(10, 10, 'wind'));
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add step', exact: true }).click();
    await page.locator('.st-step-name-input').waitFor();
    await page.locator('.st-step-name-input').fill('Watch the water');
    await page.locator('.st-step-name-input').press('Enter');
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.filter((node) => node.label === 'Watch the water').map((node) => node.prerequisites)), [['wind']]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


for (const surface of ['tree', 'board']) {
  hostTest(`Chromium: a direct step link closes to the ${surface} identity without discarding unrelated address state`, async () => {
    const { page, errors } = await openHost({ width: 1440, surface });
    try {
      await page.evaluate(() => history.replaceState({ retained: true }, '', location.hash + '?inspect=1&step=wind'));
      await page.reload();
      const step = page.getByRole('article', { name: 'Read the wind', exact: true });
      await step.waitFor();
      const entry = await page.evaluate(() => ({ state: history.state, length: history.length }));
      assert.match(entry.state.windmillHistory.chain, /^[0-9a-f-]{36}$/);
      assert.match(entry.state.windmillHistory.entryId, /^[0-9a-f-]{36}$/);
      const expectedState = {
        retained: true,
        windmillNavigation: { href: `/roadmap-host-test?role=owner&surface=${surface}#/app/t_sail?inspect=1&step=wind`, previous: null },
        windmillHistory: { chain: entry.state.windmillHistory.chain, position: 0, entryId: entry.state.windmillHistory.entryId },
      };
      assert.deepEqual(entry.state, expectedState);
      await step.getByRole('button', { name: STEP_DETAIL.close, exact: true }).click();
      await step.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity'));
      assert.deepEqual(await page.evaluate(() => [location.hash, history.state, history.length]),
        ['#/app/t_sail?inspect=1', expectedState, entry.length]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: a delayed copy result cannot announce on a later step or steal Coach focus', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => new Promise((resolve) => { window.finishCopy = resolve; });
      window.scene.activate('wind');
    });
    await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
    await page.getByRole('menuitem', { name: STEP_DETAIL.copyLink, exact: true }).click();
    await page.locator('.st-board-step-row').filter({ hasText: 'Leave the dock' }).click();
    await page.getByRole('article', { name: 'Leave the dock', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Collapse Coach' }).focus();
    await page.evaluate(() => window.finishCopy());
    await page.waitForFunction(() => window.events.some(({ name, props }) => name === 'roadmap_board_step_action' && props.action === 'copyLink' && props.outcome === 'ok'));
    assert.equal(await page.locator('.st-graph-toast').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Collapse Coach');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const options of [
  { role: 'owner', address: '#/t/', auth: 'signed-in' },
  { role: 'reader', address: '#/t/', auth: 'signed-in' },
  { role: 'reader', appUrl: true, auth: 'signed-in' },
  { demo: true },
]) {
  hostTest(`Chromium: ${JSON.stringify(options)} reads shared content without persisted device-private workspace`, async () => {
    const workspace = { wind: { note: 'Private preparation note', subtasks: [{ id: 'secret', label: 'Private task', done: false }], links: [] } };
    const { page, errors, requests } = await openHost({ width: 744, workspace, ...options });
    try {
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
      await page.evaluate(() => window.scene.activate('wind'));
      const step = page.getByRole('article', { name: 'Read the wind', exact: true });
      await step.waitFor();
      assert.equal(await step.locator('.st-board-workspace').count(), 0);
      assert.equal(await step.getByRole('button', { name: 'Edit name', exact: true }).count(), 0);
      assert.equal(await page.getByText('Private preparation note', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Private task', { exact: true }).count(), 0);
      assert.equal(await step.locator('.st-step-history-section').count(), 1);
      assert.deepEqual(requests.filter((path) => path.endsWith('/guides')), []);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_workspace')), []);
      assert.equal(await page.evaluate(() => JSON.stringify([window.events, window.issues]).includes('Private')), false);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: reader history describes a completion snapshot without attributing it to the viewer', async () => {
  const { page, errors } = await openHost({ width: 744, role: 'reader' });
  try {
    await page.evaluate(() => window.scene.activate('course'));
    await page.getByRole('article', { name: 'Choose a course', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.st-board-workspace-event > span:not(.st-event-avatar)').allTextContents(), ['Choose a course completed']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: demotion revokes completion Undo without a progress write or Undo event', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.locator('.st-board-step-undo').waitFor();
    await page.evaluate(() => {
      window.progressWrites = [];
      const mark = window.session.markProgress.bind(window.session);
      window.session.markProgress = (...args) => { window.progressWrites.push(args); return mark(...args); };
      window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } }));
    });
    await page.locator('.st-board-step-undo').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Reset', exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.progressWrites), []);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_board_step_action' && props.action === 'undo')), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: demotion closes private note editing while preserving stored workspace and reader Escape', async () => {
  const workspace = { wind: { note: 'Private preparation note', subtasks: [], links: [] } };
  const { page, errors } = await openHost({ width: 744, workspace });
  try {
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
    await page.evaluate(() => window.scene.activate('wind'));
    await page.locator('.st-board-workspace-note-heading').getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Note', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } })));
    await page.locator('.st-board-workspace, .st-board-note-editor').waitFor({ state: 'detached' });
    assert.equal(await page.getByText('Private preparation note', { exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
    await page.getByRole('article').focus();
    await page.keyboard.press('Escape');
    await page.getByRole('article').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_workspace')), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 744, 1440]) {
  hostTest(`Chromium: the nested tree picker isolates Shell and Coach at ${width}px and restores prior inertness and focus`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      const attach = page.getByRole('button', { name: 'Attach a tree', exact: true });
      await attach.click();
      const picker = page.getByRole('dialog', { name: 'Attach a tree', exact: true });
      await picker.waitFor();
      assert.equal(await page.locator('.wm-head').evaluate((node) => !!node.closest('[inert]')), true);
      if (width > 390) {
        assert.equal(await page.locator('.st-step-coach').evaluate((node) => !!node.closest('[inert]')), true);
        await assert.rejects(page.locator('.st-step-coach button').click({ timeout: 500 }), /Timeout/);
      }
      await page.keyboard.press('Tab');
      assert.equal(await picker.evaluate((node) => node.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      await picker.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Attach a tree');
      assert.equal(await page.locator('.wm-head').evaluate((node) => !!node.closest('[inert]')), false);
      assert.equal(await page.locator('.st-product-canvas').evaluate((node) => node.inert), true);
      if (width > 390) assert.equal(await page.locator('.st-step-coach').evaluate((node) => !!node.closest('[inert]')), false);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ props }) => props.action === 'collapseCoach' || props.action === 'expandCoach')), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: the first tablet node tap after remove-link mode opens the shared document', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => { window.scene.pickEdge = () => ({ from: 'wind', to: 'dock' }); window.editTap(10, 10, null); });
    await page.getByRole('group', { name: 'Remove this link', exact: true }).waitFor();
    await page.evaluate(() => window.editTap(10, 10, 'wind'));
    await page.getByRole('group', { name: 'Remove this link', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'dock').prerequisites), ['wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Open in Graph focuses its canvas and View branch reveals the existing Board filter', async () => {
  const { page, errors } = await openHost({ width: 1440, surface: 'board', broad: true });
  try {
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.locator('.st-step-toolbar').getByRole('button', { name: STEP_DETAIL.openInGraph, exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('canvas[data-graph-focus]'));
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'tree');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: STEP_DETAIL.viewBranch, exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    await page.locator('.st-roadmap-identity[data-view="board"]').waitFor();
    await page.locator('.st-board-card[data-step-id="knots"]').waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.st-board-card').evaluateAll((cards) => cards.map((card) => card.dataset.stepId).sort()), ['course', 'dock', 'wind']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
