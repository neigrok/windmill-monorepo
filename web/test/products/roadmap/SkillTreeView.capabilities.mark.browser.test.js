// §2.5 of the wave-8 architecture: marking steps and selecting several have their Board homes.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { LABELS, STEP_DETAIL, completedToast, deletedStepsToast } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesMark');

const everyWidth = [320, 390, 744, 1440];
const phones = [320, 390];

async function openStep(page, id) {
  await page.locator(`.st-board-card[data-step-id="${id}"]`).evaluate((card) => card.click());
  await page.locator('.st-board-step-layer [role="dialog"]').waitFor();
}

async function openColumn(page, width, column) {
  if (width >= 1024) return;
  if (width >= 744) {
    const show = page.getByRole('button', { name: `${LABELS.show} ${column}`, exact: true });
    if (await show.count() > 0) await show.click();
    return;
  }
  await page.getByRole('tab', { name: new RegExp(`^${column},`) }).click();
}

function savedStep(page, id) {
  return page.evaluate((id) => {
    const { label, description, color, prerequisites } = window.session.lattice.toTreeData().nodes.find((node) => node.id === id);
    return { label, description, color, prerequisites: [...prerequisites].sort() };
  }, id);
}

async function touchDrag(page, from, to, { holdMs = 0 } = {}) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction,
    }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function cardCenter(page, id) {
  const box = await page.locator(`.st-board-phone-pane.is-shown .st-board-card[data-step-id="${id}"]`).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const width of phones) {
  hostTest(`§2.5 Mark done (swipe): swipe reveals Complete on an Up next card at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', touch: true });
    try {
      const from = await cardCenter(page, 'wind');
      await touchDrag(page, from, { x: from.x + 110, y: from.y });
      await page.locator('.st-board-swipe.is-open').waitFor();
      assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
      await page.getByRole('button', { name: `${STEP_DETAIL.complete} Read the wind`, exact: true }).click();
      await page.waitForFunction(() => window.session.progress.overlay().completed.has('wind'));
      await page.locator('.st-board-toast-message').filter({ hasText: completedToast({ step: 'Read the wind', unlocked: ['Leave the dock'] }) }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [744, 1440]) {
  hostTest(`§2.5 Mark done (C): the key completes a focused Up next card at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await page.locator('[data-column="upNext"] .st-board-card[data-step-id="wind"]').focus();
      await page.keyboard.press('c');
      await page.waitForFunction(() => window.session.progress.overlay().completed.has('wind'));
      await page.locator('.st-board-toast-message').filter({ hasText: completedToast({ step: 'Read the wind', unlocked: ['Leave the dock'] }) }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of everyWidth) {
  hostTest(`§2.5 Not done: Reset on the step page at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await openColumn(page, width, 'Done');
      await openStep(page, 'course');
      await page.locator('.st-board-step-layer').getByRole('button', { name: STEP_DETAIL.reset, exact: true }).click();
      await page.waitForFunction(() => !window.session.progress.overlay().completed.has('course'));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Mark done · not done: a reader has no way to mark at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', surface: 'board' });
    try {
      assert.equal(await page.locator('.st-board-swipe, .st-board-swipe-complete').count(), 0);
      await openStep(page, 'wind');
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.complete, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.reset, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of phones) {
  hostTest(`§2.5 Select several, recolor: the Board's hold selection at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', broad: true, touch: true });
    try {
      const from = await cardCenter(page, 'knots');
      await touchDrag(page, from, from, { holdMs: 600 });
      await page.locator('.st-board-bulk').waitFor();
      await page.locator('.st-board-phone-pane.is-shown .st-board-card[data-step-id="charts"]').click();
      await page.getByRole('button', { name: LABELS.recolor, exact: true }).click();
      await page.getByRole('radio', { name: 'Olive', exact: true }).click();
      await page.getByRole('tablist').waitFor();
      assert.deepEqual([(await savedStep(page, 'knots')).color, (await savedStep(page, 'charts')).color, (await savedStep(page, 'wind')).color],
        ['olive', 'olive', 'terracotta']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Select several, delete: the Board's hold selection at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board', broad: true, touch: true });
    try {
      const from = await cardCenter(page, 'knots');
      await touchDrag(page, from, from, { holdMs: 600 });
      await page.locator('.st-board-bulk').waitFor();
      await page.locator('.st-board-phone-pane.is-shown .st-board-card[data-step-id="charts"]').click();
      await page.locator('.st-board-bulk-actions').getByRole('button', { name: /^Delete/ }).click();
      await page.locator('.st-board-toast-message').filter({ hasText: deletedStepsToast({ count: 2 }) }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.st-board-card[data-step-id="knots"], .st-board-card[data-step-id="charts"]').length === 0);
      await page.locator('.st-board-toast-undo').click();
      await page.locator('.st-board-card[data-step-id="knots"]').waitFor({ state: 'attached' });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Select several: a reader's hold selects nothing at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', surface: 'board', broad: true, touch: true });
    try {
      const from = await cardCenter(page, 'knots');
      await touchDrag(page, from, from, { holdMs: 600 });
      assert.equal(await page.locator('.st-board-bulk').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
