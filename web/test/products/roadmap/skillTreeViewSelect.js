import assert from 'node:assert/strict';
import { Board, DONE_RECENT_LIMIT } from '../../../src/products/roadmap/board/Board.js';
import { SkillTree } from '../../../src/products/roadmap/model/SkillTree.js';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { BULK, COLUMN_TITLES, LABELS, SORT_MENU, SORT_LABELS, STEP_DETAIL, VIEW_SWITCH, deleteStepsAction, selectedCount, selectingAnnouncement } from '../../../src/products/roadmap/copy.js';

const cardSelector = (id) => `.st-board-phone-pane.is-shown .st-board-card[data-step-id="${id}"]`;
const liveSelector = '.st-board-phone > .st-board-spoken[role="status"]';

async function selectFromMenu(page, input = 'click') {
  await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
  await page.getByRole('menuitem', { name: STEP_DETAIL.select, exact: true })[input]();
  await page.locator('.st-board-step-layer').waitFor({ state: 'detached' });
  await page.getByRole('region', { name: BULK.region, exact: true }).waitFor();
}

async function selectedFocus(page, id) {
  await page.waitForFunction((id) => document.activeElement?.dataset.stepId === id
    && document.activeElement.getAttribute('aria-pressed') === 'true', id);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.stepId), id);
}

async function ended(page, id) {
  await page.getByRole('region', { name: BULK.region, exact: true }).waitFor({ state: 'detached' });
  await page.waitForFunction((id) => !history.state?.boardSelection && document.activeElement?.dataset.stepId === id, id);
  assert.equal(await page.locator(liveSelector).textContent(), '');
}

export function selectCases({ browserType }) {
  const browserName = browserType.name();
  startRoadmapHost({ browserTypes: { [browserName]: browserType } });

  hostTest(`${browserName}: phone Select, tap toggles and Done restore the last toggled card`, async () => {
    const { page, errors } = await openHost({ browserName, width: 390, surface: 'board', broad: true, touch: true });
    try {
      await page.locator(liveSelector).waitFor({ state: 'attached' });
      assert.equal(await page.locator(liveSelector).textContent(), '');
      await page.evaluate((selector) => { window.selectionStatus = document.querySelector(selector); }, liveSelector);
      await page.locator(cardSelector('wind')).tap();
      await selectFromMenu(page, 'tap');
      await selectedFocus(page, 'wind');
      assert.equal(await page.locator(liveSelector).textContent(), selectingAnnouncement({ count: 1 }));
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('step')), null);
      assert.deepEqual(await page.getByRole('region', { name: BULK.region, exact: true }).evaluate((bar) => ({
        heading: bar.firstElementChild.tagName,
        headingText: bar.firstElementChild.textContent,
        headingTabindex: bar.firstElementChild.getAttribute('tabindex'),
        buttons: [...bar.querySelectorAll('button')].filter((button) => !button.closest('[inert]')).map((button) => button.textContent),
      })), { heading: 'H2', headingText: selectedCount({ count: 1 }), headingTabindex: null,
        buttons: [BULK.done, BULK.recolor, deleteStepsAction({ count: 1 })] });
      await page.locator(cardSelector('knots')).tap();
      await page.getByRole('heading', { name: selectedCount({ count: 2 }), exact: true }).waitFor();
      assert.equal(await page.locator(cardSelector('knots')).getAttribute('aria-pressed'), 'true');
      await page.locator(cardSelector('knots')).tap();
      await page.getByRole('heading', { name: selectedCount({ count: 1 }), exact: true }).waitFor();
      assert.equal(await page.locator(cardSelector('knots')).getAttribute('aria-pressed'), 'false');
      await page.getByRole('button', { name: BULK.done, exact: true }).tap();
      await ended(page, 'knots');
      assert.equal(await page.evaluate((selector) => window.selectionStatus === document.querySelector(selector), liveSelector), true);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_board_select'
        || (name === 'roadmap_board_step_action' && props.action === 'select'))), [
        { name: 'roadmap_board_step_action', props: { surface: 'page', action: 'select' } },
        { name: 'roadmap_board_select', props: { step: 'start' } },
        { name: 'roadmap_board_select', props: { step: 'end', via: 'done' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  if (browserName !== 'chromium') return;

  hostTest('Chromium: Space and Enter toggle, Tab reaches Done, and Escape and Done restore the last card', async () => {
    const { page, errors } = await openHost({ width: 390, surface: 'board', broad: true });
    try {
      for (const end of ['escape', 'done']) {
        await page.locator(cardSelector('wind')).click();
        await selectFromMenu(page);
        await selectedFocus(page, 'wind');
        await page.locator(cardSelector('knots')).focus();
        await page.keyboard.press('Space');
        await page.getByRole('heading', { name: selectedCount({ count: 2 }), exact: true }).waitFor();
        assert.equal(await page.locator(liveSelector).textContent(), selectedCount({ count: 2 }));
        await page.keyboard.press('Enter');
        await page.getByRole('heading', { name: selectedCount({ count: 1 }), exact: true }).waitFor();
        assert.equal(await page.locator(liveSelector).textContent(), selectedCount({ count: 1 }));
        await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('button', { name: BULK.done, exact: true }).evaluate((button) => button === document.activeElement), true);
        if (end === 'escape') await page.keyboard.press('Escape');
        else await page.keyboard.press('Enter');
        await ended(page, 'knots');
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest('Chromium: Select after Unlocks follows the selected child and Back ends selection without reopening a page', async () => {
    const { page, errors } = await openHost({ width: 390, surface: 'board' });
    try {
      await page.locator(cardSelector('wind')).click();
      await page.locator('.st-board-step-row').filter({ hasText: 'Leave the dock' }).click();
      await page.locator('.st-board-step-identity-title').filter({ hasText: 'Leave the dock' }).waitFor();
      await selectFromMenu(page);
      await selectedFocus(page, 'dock');
      assert.equal(await page.locator('.st-board-phone-pane.is-shown').getAttribute('data-column'), 'locked');
      assert.equal(await page.evaluate(() => Boolean(history.state?.boardStep)), false);
      await page.evaluate(() => history.back());
      await ended(page, 'dock');
      assert.equal(await page.locator('.st-board-step-layer').count(), 0);
      assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('step')), null);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_select')), [
        { name: 'roadmap_board_select', props: { step: 'start' } },
        { name: 'roadmap_board_select', props: { step: 'end', via: 'back' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest('Chromium: Select reveals only the hiding search and preserves sort', async () => {
    const { page, errors } = await openHost({ width: 390, surface: 'board' });
    try {
      await page.getByRole('button', { name: LABELS.sort, exact: true }).click();
      await page.getByRole('menuitemradio', { name: SORT_MENU.options.newest, exact: true }).click();
      await page.getByRole('searchbox', { name: LABELS.findStep, exact: true }).fill('Read the wind');
      await page.locator('.st-board-card[data-step-id="dock"]').waitFor({ state: 'detached' });
      await page.locator(cardSelector('wind')).click();
      await page.locator('.st-board-step-row').filter({ hasText: 'Leave the dock' }).click();
      await selectFromMenu(page);
      await selectedFocus(page, 'dock');
      await page.getByRole('button', { name: BULK.done, exact: true }).click();
      await ended(page, 'dock');
      assert.equal(await page.getByRole('searchbox', { name: LABELS.findStep, exact: true }).inputValue(), '');
      assert.equal(await page.locator('.st-board-chip').filter({ hasText: SORT_LABELS.newest }).count(), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest('Chromium: Select expands a Done step beyond the fold and keeps it focused', async () => {
    const { page, errors } = await openHost({ width: 390, surface: 'board', large: true, allDone: true });
    try {
      await page.getByRole('tab', { name: new RegExp(`^${COLUMN_TITLES.done},`) }).click();
      const snapshot = await page.evaluate(() => ({ tree: window.session.lattice.toTreeData(),
        completed: [...window.session.progress.overlay().completed], completedAt: window.session.progress.overlay().completedAt }));
      const board = new Board(new SkillTree(snapshot.tree), { completed: new Set(snapshot.completed), completedAt: snapshot.completedAt });
      const target = board.done.cards.slice(DONE_RECENT_LIMIT).find(({ id }) => id !== 'course').id;
      assert.equal(await page.locator(cardSelector(target)).count(), 0);
      await page.evaluate((id) => { location.hash = '#/app/t_sail?step=' + encodeURIComponent(id); }, target);
      await page.locator('.st-board-step-page').waitFor();
      await selectFromMenu(page);
      await selectedFocus(page, target);
      assert.equal(await page.locator('.st-board-phone-pane.is-shown').getAttribute('data-column'), 'done');
      assert.equal(await page.locator('.st-board-phone-pane.is-shown .st-board-show-all').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  for (const options of [
    { width: 390, role: 'reader', surface: 'board' },
    { width: 390, single: true, surface: 'board' },
    { width: 390, surface: 'tree' },
    { width: 744, surface: 'board' },
    { width: 1440, surface: 'board' },
    { width: 390, demo: true, surface: 'board' },
  ]) {
    hostTest(`Chromium: Select is not offered outside owner phone Board selection ${JSON.stringify(options)}`, async () => {
      const { page, errors } = await openHost(options);
      try {
        if (options.demo) await page.getByRole('button', { name: VIEW_SWITCH.board, exact: true }).click();
        await page.evaluate((id) => { location.hash = '#/app/t_sail?step=' + id; }, options.single ? 'course' : 'wind');
        await page.locator('.st-board-step-layer').waitFor();
        await page.getByRole('button', { name: STEP_DETAIL.more, exact: true }).click();
        assert.equal(await page.getByRole('menuitem', { name: STEP_DETAIL.select, exact: true }).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest('Chromium: hold uses the mounted live region and toggling its final card ends selection', async () => {
    const { page, errors } = await openHost({ width: 390, surface: 'board', fixedClock: true });
    try {
      await page.evaluate((selector) => { window.selectionStatus = document.querySelector(selector); }, liveSelector);
      const card = page.locator(cardSelector('wind'));
      const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: 100, clientY: 200 };
      await card.dispatchEvent('pointerdown', touch);
      await page.clock.runFor(501);
      await card.dispatchEvent('pointerup', touch);
      await card.dispatchEvent('click');
      await page.getByRole('region', { name: BULK.region, exact: true }).waitFor();
      assert.equal(await page.locator(liveSelector).textContent(), selectingAnnouncement({ count: 1 }));
      await card.focus();
      await page.evaluate(() => {
        window.selectionPopped = new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
      });
      await page.keyboard.press('Space');
      await page.evaluate(() => window.selectionPopped);
      await page.clock.runFor(100);
      await ended(page, 'wind');
      assert.equal(await page.evaluate((selector) => window.selectionStatus === document.querySelector(selector), liveSelector), true);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_select')), [
        { name: 'roadmap_board_select', props: { step: 'start' } },
        { name: 'roadmap_board_select', props: { step: 'end', via: 'emptied' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
