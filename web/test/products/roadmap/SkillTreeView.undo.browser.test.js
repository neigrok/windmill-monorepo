// A toast's Undo reverts its own act on every band; ⌘Z and ⇧⌘Z stay the session's global stack across both views.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { LABELS } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const steps = (page) => page.evaluate(() => Object.fromEntries(window.session.lattice.toTreeData().nodes
  .map(({ id, label, color, prerequisites }) => [id, { label, color, prerequisites: [...prerequisites] }])));
const toastEvents = (page) => page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_toast').map(({ props }) => props));
const graphToast = (page) => page.locator('.st-graph-toast .st-board-toast');
const undoButton = (page) => graphToast(page).getByRole('button', { name: LABELS.undo, exact: true });
const laterLink = (page) => page.evaluate(() => window.scene.options.onConnectNodes('knots', 'charts'));

hostTest('Chromium: desktop delete Undo after a later link keeps the link, and ⌘Z then takes that link alone', async () => {
  const { page, errors } = await openHost({ width: 1440, broad: true });
  try {
    const before = await steps(page);
    await page.evaluate(() => window.scene.select('dock'));
    await page.getByRole('button', { name: 'Delete step', exact: true }).click();
    await graphToast(page).waitFor();
    assert.equal(await graphToast(page).locator('.st-board-toast-message').textContent(), 'Step deleted');
    await laterLink(page);
    await undoButton(page).click();
    await page.waitForFunction(() => window.session.lattice.toTreeData().nodes.some(({ id }) => id === 'dock'));
    const linked = { ...before, charts: { ...before.charts, prerequisites: [...before.charts.prerequisites, 'knots'] } };
    assert.deepEqual(await steps(page), linked);
    assert.deepEqual(await toastEvents(page), [{ act: 'delete', step: 'shown' }, { act: 'delete', step: 'undo' }]);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => window.session.undoStack.length === 0);
    assert.deepEqual(await steps(page), before);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.waitForFunction(() => window.session.redoStack.length === 0);
    assert.deepEqual(await steps(page), linked);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the global stack crosses views while a step covering the Board refuses it', async () => {
  const { page, errors } = await openHost({ width: 1440, broad: true });
  try {
    const before = await steps(page);
    await laterLink(page);
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card').first().waitFor();
    await page.locator('.st-board-card[data-step-id="wind"]').click();
    await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal(await page.evaluate(() => window.session.undoStack.length), 1);
    await page.keyboard.press('Escape');
    await page.locator('.st-board-step-layer [role="dialog"]').waitFor({ state: 'detached' });
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(() => window.session.undoStack.length === 0);
    assert.deepEqual(await steps(page), before);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a pasted plan\'s Undo removes its steps and keeps a later link', async () => {
  const { page, errors } = await openHost({ width: 1440, broad: true });
  try {
    const before = await steps(page);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '- Rent a boat\n- Find a crew');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await page.locator('.pc-plant').click();
    await graphToast(page).waitFor();
    assert.equal(await graphToast(page).locator('.st-board-toast-message').textContent(), 'Added 2 steps under “Choose a course”');
    assert.equal(Object.keys(await steps(page)).length, 7);
    await laterLink(page);
    await undoButton(page).click();
    await page.waitForFunction(() => window.session.lattice.toTreeData().nodes.length === 5);
    assert.deepEqual(await steps(page), { ...before, charts: { ...before.charts, prerequisites: [...before.charts.prerequisites, 'knots'] } });
    assert.deepEqual(await toastEvents(page), [{ act: 'graft', step: 'shown' }, { act: 'graft', step: 'undo' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a plan pasted on the Board counts what it adds, shows its toast and Undo on the Board, and the Undo removes its steps', async () => {
  const { page, errors } = await openHost({ width: 1440, surface: 'board', broad: true });
  try {
    await page.locator('.st-board-card').first().waitFor();
    const before = await steps(page);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '- Rent a boat\n- Find a crew');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator('.pc-readout').textContent(), '2 steps');
    await page.locator('.pc-plant').click();
    const toast = page.locator('.st-view-layer--board .st-board-toast');
    await toast.waitFor();
    assert.equal(await toast.locator('.st-board-toast-message').textContent(), 'Added 2 steps under “Choose a course”');
    assert.equal(Object.keys(await steps(page)).length, 7);
    await toast.getByRole('button', { name: LABELS.undo, exact: true }).click();
    await page.waitForFunction(() => window.session.lattice.toTreeData().nodes.length === 5);
    assert.deepEqual(await steps(page), before);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_undo' || name === 'roadmap_board_create')), [
      { name: 'roadmap_board_create', props: { step: 'open', door: 'paste', view: 'board' } },
      { name: 'roadmap_board_create', props: { step: 'saved', door: 'paste', view: 'board', count: '2-5' } },
      { name: 'roadmap_board_undo', props: { act: 'graft' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a tablet add, rename, recolor, link and link removal each offer an Undo for their own act', async () => {
  const { page, errors } = await openHost({ width: 744, broad: true });
  try {
    const before = await steps(page);
    const undoAfterLaterLink = async (message) => {
      await graphToast(page).locator('.st-board-toast-message').filter({ hasText: message }).waitFor();
      await page.evaluate(() => window.session.dispatch({ kind: 'SetNodeOrder', id: 'knots', order: 'z' }));
      await undoButton(page).click();
      await graphToast(page).waitFor({ state: 'detached' });
    };
    await page.evaluate(() => window.editTap(0, 0, 'wind'));
    const editor = page.locator('.st-detail-panel--open');
    await editor.getByRole('button', { name: 'Add step', exact: true }).click();
    await undoAfterLaterLink('Step added');
    assert.deepEqual(Object.keys(await steps(page)).sort(), Object.keys(before).sort());

    await page.evaluate(() => window.editTap(0, 0, 'wind'));
    await editor.getByRole('radio', { name: 'Sky', exact: true }).click();
    await undoAfterLaterLink('Recolored');
    assert.equal((await steps(page)).wind.color, before.wind.color);

    await editor.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.evaluate(() => window.editTap(0, 0, 'knots'));
    await undoAfterLaterLink('Linked');
    assert.deepEqual((await steps(page)).knots.prerequisites, before.knots.prerequisites);

    assert.deepEqual(await toastEvents(page), [
      { act: 'add', step: 'shown' }, { act: 'add', step: 'undo' },
      { act: 'recolor', step: 'shown' }, { act: 'recolor', step: 'undo' },
      { act: 'link_add', step: 'shown' }, { act: 'link_add', step: 'undo' },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a revert that throws reports its static operation and claims no Undo', async () => {
  const { page, errors } = await openHost({ width: 1440, broad: true });
  try {
    await page.evaluate(() => window.scene.select('dock'));
    await page.getByRole('button', { name: 'Delete step', exact: true }).click();
    await graphToast(page).waitFor();
    await page.evaluate(() => { window.session.revert = () => { throw new Error('Fixture revert failure'); }; });
    await undoButton(page).click();
    await page.waitForFunction(() => window.issues.length > 0);
    assert.deepEqual(await page.evaluate(() => window.issues), [{ operation: 'roadmap-graph-undo', stack: true }]);
    assert.deepEqual(await toastEvents(page), [{ act: 'delete', step: 'shown' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Ask AI answers in its pill, opens its reason, and Undo says what it reverted', async () => {
  const { page, errors } = await openHost({ width: 1440, broad: true });
  try {
    await page.route('**/v1/trees/t_sail/tend', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 'done', summary: 'Added 1 step', edits: 1, created: ['knots'], detail: 'One step fits here.',
    }) }));
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.locator('.st-tend-input, input[placeholder], textarea').last().fill('Add a step');
    await page.keyboard.press('Enter');
    const pill = page.locator('.st-toast');
    await pill.waitFor();
    assert.equal(await pill.textContent(), 'Added 1 stepWhy?Undo');
    assert.equal(await page.locator('.st-board-toast').count(), 0);
    await pill.getByRole('button', { name: 'Why?', exact: true }).click();
    assert.equal(await pill.textContent(), 'Added 1 stepHideUndoOne step fits here.');
    await pill.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.st-toast')?.textContent === 'AI changes reverted');
    assert.equal(Object.keys(await steps(page)).includes('knots'), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
