// Every capability ControlBar, the lane and the plaque carried has its home in the row, the sheet or the Graph's chrome:
// §2.5 of the wave-8 architecture. One test per row, band and role, each named for its row.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ACTIVITY, ANONYMOUS_OWNER, DEMO_BYLINE, FORK_OFFER, LAPSED_SESSION, ROADMAP_SHEET, ROADMAP_VERBS } from '../../../src/products/roadmap/board/copy.js';
import { DEMO_COPY } from '../../../src/products/roadmap/demo/demoStage.js';

startRoadmapHost('capabilitiesChrome');

const everyWidth = [320, 390, 744, 1440];
const phones = [320, 390];
const wide = [744, 1440];
const bothRoles = ['owner', 'reader'];

function openSheet(page) {
  return page.locator('.st-roadmap-title-button').click().then(() => page.getByRole('dialog', { name: ROADMAP_SHEET.title, exact: true }));
}

function identityView(page) {
  return page.locator('.st-roadmap-identity').getAttribute('data-view');
}

for (const width of wide) {
  hostTest(`§2.5 Switch roadmap · Plant · Planted in public: the row's switcher at ${width}px for owner`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      const switcher = page.locator('.st-roadmap-switcher');
      await switcher.locator('[aria-haspopup="menu"]').click();
      const menu = switcher.getByRole('menu');
      await menu.getByRole('menuitem', { name: /Spanish basics/ }).waitFor();
      assert.equal(await menu.getByRole('menuitem', { name: 'Browse trees planted in public', exact: true }).count(), 1);
      await menu.getByRole('menuitem', { name: /New/ }).click();
      await page.waitForFunction(() => location.hash === '#/app/new');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  for (const role of bothRoles) {
    hostTest(`§2.5 Desktop topbar: zoom, Focus, All steps: the camera pill at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        const camera = page.locator('.st-graph-camera');
        await camera.getByRole('button', { name: 'Zoom in', exact: true }).click();
        await camera.getByRole('button', { name: 'Zoom out', exact: true }).click();
        await camera.getByRole('button', { name: 'Focus', exact: true }).click();
        await camera.getByRole('button', { name: 'All steps', exact: true }).click();
        const calls = await page.evaluate(() => window.cameraCalls.map(([name]) => name));
        assert.deepEqual(calls.slice(-4), ['zoomBy', 'zoomBy', 'focusWorking', 'fitToView']);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const width of phones) {
  for (const role of bothRoles) {
    hostTest(`§2.5 Desktop topbar: Focus, All steps: the phone camera group at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        const camera = page.getByRole('group', { name: 'Camera', exact: true });
        await camera.getByRole('button', { name: 'Focus', exact: true }).click();
        await camera.getByRole('button', { name: 'All steps', exact: true }).click();
        assert.deepEqual((await page.evaluate(() => window.cameraCalls.map(([name]) => name))).slice(-2), ['focusWorking', 'fitToView']);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const width of everyWidth) {
  for (const role of bothRoles) {
    hostTest(`§2.5 Tree / List pill: the identity switch at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        const row = page.locator('.st-roadmap-identity');
        assert.equal(await identityView(page), 'tree');
        await row.getByRole('button', { name: 'Board', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'board');
        await page.locator('.st-view-layer--board.is-active .st-board-card').first().waitFor({ state: 'attached' });
        await row.getByRole('button', { name: 'Graph', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.st-roadmap-identity').dataset.view === 'tree');
        assert.equal(await page.locator('.st-view-pill, .st-action-lane').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    hostTest(`§2.5 Reader plaque: author line (G8-R1): no author in the row at ${width}px for ${role}`, async () => {
      const { page, errors } = await openHost({ width, role });
      try {
        assert.equal(await page.locator('.st-roadmap-identity').evaluate((row) => row.textContent.includes('Ada Lovelace')), false);
        assert.equal(await page.getByText('Ada Lovelace').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }

  hostTest(`§2.5 Saved on this device / lapsed: the device line at ${width}px on Board and Graph`, async () => {
    for (const surface of ['board', 'tree']) {
      const { page, errors } = await openHost({ width, role: 'ghost', surface, shell: true });
      try {
        if (width < 744) {
          await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).click();
          assert.equal(await page.evaluate(() => window.signInOpened), 1);
        } else {
          await page.getByRole('status').filter({ hasText: ANONYMOUS_OWNER }).waitFor();
        }
        assert.equal(await page.locator('.st-list-notice').count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  });

  hostTest(`§2.5 Switch roadmap · Plant · Planted in public: a reader has no roadmap switcher at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      assert.equal(await page.locator('.st-roadmap-title-button, .st-roadmap-switcher').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Saved on this device / lapsed: a lapsed session keeps its line at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(async () => {
        window.session.receiveReject({ code: 'sign-in-required' });
        await Promise.resolve();
        window.setFixtureAuth('ghost');
      });
      const line = width < 744 ? page.getByRole('button', { name: LAPSED_SESSION, exact: true }) : page.getByRole('status').filter({ hasText: LAPSED_SESSION });
      await line.waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`§2.5 Demo plaque byline (G11): the sample badge at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader', demo: true });
    try {
      const row = page.locator('.st-roadmap-identity[data-role="demo"]');
      await row.waitFor();
      assert.equal(await row.locator('.st-roadmap-sample').textContent(), width < 744 ? DEMO_BYLINE.phone : DEMO_BYLINE.wide);
      assert.equal(await page.getByText(DEMO_COPY.plaqueByline).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
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
      assert.equal(await page.locator('.st-activity-chip, .st-activity-chip-badge').count(), 0);
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
      assert.equal(await page.locator('.st-activity-chip, .st-activity-chip-badge').count(), 0);
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
