// Every capability the phone's List, lane and legacy Graph sheet carried has its home in the roadmap sheet or the Graph's
// bar: §2.5 of the wave-8 architecture. One test per row, band and role, each named for its row.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ASK_AI_PLACEHOLDER, EDIT_STEP, FORK_OFFER, OPEN_STEP, PICKER, ROADMAP_SHEET, ROADMAP_VERBS, STEP_DETAIL, roadmapMatches, roadmapsHeading } from '../../../src/products/roadmap/board/copy.js';
import { DEMO_COPY } from '../../../src/products/roadmap/demo/demoStage.js';

startRoadmapHost('capabilitiesPhone');

const phones = [320, 390];

function openSheet(page) {
  return page.locator('.st-roadmap-title-button').click().then(() => page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true }));
}

function identityView(page) {
  return page.locator('.st-roadmap-identity').getAttribute('data-view');
}

for (const width of phones) {
  hostTest(`§2.5 Switch roadmap · Plant · Planted in public: the roadmap sheet at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      const sheet = await openSheet(page);
      assert.equal(await sheet.locator('.st-roadmap-sheet-tree[aria-current="true"] .st-roadmap-sheet-tree-name').textContent(), 'Learn to sail');
      await sheet.getByRole('button', { name: /^Spanish basics/ }).click();
      await page.waitForFunction(() => location.hash === '#/app/t_other');
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/app/new');
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/browse');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Switcher search above eight roadmaps: the sheet's Find a roadmap at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, manyTrees: true });
    try {
      const sheet = await openSheet(page);
      await sheet.getByRole('heading', { name: roadmapsHeading({ count: 13 }), exact: true }).waitFor();
      await sheet.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap, exact: true }).fill('basics');
      await sheet.getByRole('heading', { name: roadmapMatches({ shown: 1, total: 13 }), exact: true }).waitFor();
      assert.deepEqual(await sheet.locator('.st-roadmap-sheet-tree-name').allTextContents(), ['Spanish basics']);
      assert.equal(await sheet.locator('mark').textContent(), 'basics');
      assert.equal(await sheet.getByRole('button', { name: ROADMAP_SHEET.plantedInPublic, exact: true }).count(), 1);
      await sheet.getByRole('searchbox', { name: ROADMAP_SHEET.findRoadmap, exact: true }).fill('nothing like this');
      await sheet.getByRole('heading', { name: roadmapMatches({ shown: 0, total: 13 }), exact: true }).waitFor();
      await sheet.getByRole('button', { name: ROADMAP_SHEET.newRoadmap, exact: true }).click();
      await page.waitForFunction(() => location.hash === '#/app/new');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Ask AI on phones: the sheet's docked bar at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).click();
      const bar = page.getByRole('dialog', { name: ROADMAP_VERBS.askAI, exact: true });
      await bar.waitFor();
      assert.equal(await bar.getByRole('textbox').getAttribute('placeholder'), ASK_AI_PLACEHOLDER.phone);
      assert.equal(await page.locator('.st-tend-overlay').getAttribute('data-presentation'), 'docked');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Ask AI · Share on phones: a reader has neither at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      assert.equal(await page.locator('.st-roadmap-title-button').count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.askAI, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Share on phones: the sheet's Share at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width, surface: 'board' });
    try {
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_VERBS.share, exact: true }).click();
      await page.getByRole('dialog').filter({ hasText: ROADMAP_VERBS.shareRoadmap }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: open a step's details (owner): the bar's Open step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 1);
      assert.equal(await identityView(page), 'tree');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: open a step's details (G8-H1): the bar's title opens a reader's read-only page, Fork stays primary, at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      const bar = page.locator('[data-graph-step-bar]');
      assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), FORK_OFFER);
      await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.complete, exact: true }).count(), 0);
      assert.equal(await identityView(page), 'tree');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: connect or remove a link: Edit step's prerequisites at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      assert.deepEqual(await page.evaluate(() => [window.longPress, window.editTap]), [null, null]);
      await page.evaluate(() => window.scene.select('dock'));
      await page.getByRole('button', { name: OPEN_STEP, exact: true }).click();
      await page.getByRole('button', { name: STEP_DETAIL.editStep, exact: true }).click();
      await page.locator('.st-board-draft-needs').click();
      await page.getByRole('checkbox', { name: /^Read the wind/ }).click();
      await page.getByRole('checkbox', { name: /^Choose a course/ }).click();
      await page.getByRole('button', { name: PICKER.apply, exact: true }).click();
      await page.getByRole('button', { name: EDIT_STEP.save, exact: true }).click();
      await page.getByRole('dialog', { name: 'Leave the dock', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'dock').prerequisites), ['course']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: demo mark any step done (G8-M5): the bar offers Fork and the read-only page no mark at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      const bar = page.locator('[data-graph-step-bar]');
      assert.equal(await bar.locator('[data-graph-step-primary]').textContent(), FORK_OFFER);
      assert.equal(await page.locator('.st-sheet, .st-step-panel').count(), 0);
      await bar.getByRole('button', { name: 'Read the wind', exact: true }).click();
      await page.getByRole('dialog', { name: 'Read the wind', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: STEP_DETAIL.complete, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Mark done', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Phone Graph: demo mark any step done (G8-M5): CoachChip keeps the play at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true });
    try {
      const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
      await mark.waitFor({ timeout: 8000 });
      assert.equal(await page.getByText(DEMO_COPY.coachSentence, { exact: true }).count(), 1);
      await mark.click();
      await page.locator('.st-board-toast-message').filter({ hasText: DEMO_COPY.unlockToast }).waitFor();
      await page.waitForFunction(() => document.querySelector('.st-roadmap-progress')?.getAttribute('aria-label') === '1 of 4 steps done');
      assert.equal(await mark.count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo CTA echo on Fork (G8-M12): the pill alone pulses after the coached step at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true, motion: true });
    try {
      const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
      await mark.waitFor({ timeout: 8000 });
      await mark.click();
      const pill = page.getByRole('button', { name: FORK_OFFER, exact: true });
      await page.waitForFunction((label) => [...document.querySelectorAll('button.wm-cta-echo')].some((button) => button.textContent.trim() === label), FORK_OFFER, { timeout: 4000 });
      assert.match(await pill.getAttribute('class'), /wm-cta-echo/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
