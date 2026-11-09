// §2.5 of the wave-8 architecture: every Fork and Activity door has its home.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, FORK_OFFER, ROADMAP_SHEET, ROADMAP_VERBS } from '../../../src/products/roadmap/copy.js';
import { DEMO_COPY } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const phones = [320, 390];
const wide = [744, 1440];

function openSheet(page) {
  return page.locator('.st-roadmap-title-button').click().then(() => page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true }));
}

for (const width of phones) {
  hostTest(`§2.5 Reader Fork: the Graph's pill, the bar and the Board's offer at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      const fork = page.getByRole('button', { name: FORK_OFFER, exact: true });
      await fork.click();
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.scene.select('wind'));
      await page.locator('[data-graph-step-primary]').click();
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.st-roadmap-identity').getByRole('button', { name: 'Board', exact: true }).click();
      await page.locator('.st-board-phone-notices').getByRole('button', { name: FORK_OFFER, exact: true }).click();
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Activity (G8-A1, G8-R2): the sheet's Activity page, no badge, at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await (await openSheet(page)).getByRole('button', { name: ROADMAP_VERBS.activity, exact: true }).click();
      await page.getByRole('dialog', { name: ACTIVITY.heading, exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Activity: a reader has no Activity at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      await page.keyboard.press('a');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.locator('.st-activity, .st-roadmap-activity-panel').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of wide) {
  hostTest(`§2.5 Reader Fork: the door opens for a reader on an app URL at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', appUrl: true });
    try {
      await page.locator('.st-roadmap-identity').getByRole('button', { name: ROADMAP_VERBS.fork, exact: true }).click();
      await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Reader Fork: the row's Fork at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      for (const surface of ['tree', 'board']) {
        if (surface === 'board') await page.locator('.st-roadmap-identity').getByRole('button', { name: 'Board', exact: true }).click();
        await page.locator('.st-roadmap-identity').getByRole('button', { name: ROADMAP_VERBS.fork, exact: true }).click();
        await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('heading', { name: 'Make it yours', exact: true }).waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo CTA echo on Fork (G8-M12): the row's Fork does not pulse at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true, coached: true, motion: true });
    try {
      const mark = page.getByRole('button', { name: DEMO_COPY.coachButton, exact: true });
      await mark.waitFor({ timeout: 8000 });
      await mark.click();
      await page.waitForTimeout(1700);
      assert.equal(await page.locator('.wm-cta-echo').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Activity (G8-A1, G8-R2): More → Activity, no badge, at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.locator('.st-roadmap-identity').getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).click();
      await page.getByRole('menuitem', { name: ROADMAP_VERBS.activity }).click();
      await page.locator(width === 744 ? '.st-roadmap-activity-panel' : '.st-detail-panel--open .st-activity').waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Activity: a reader has no Activity at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      await page.keyboard.press('a');
      assert.equal(await page.locator('.st-activity, .st-roadmap-activity-panel').count(), 0);
      assert.equal(await page.locator('.st-roadmap-identity').getByRole('button', { name: ROADMAP_VERBS.more, exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
