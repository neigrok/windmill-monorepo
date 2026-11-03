// What ControlBar, the lane and the plaque carried has its home in the row and the Graph's camera: §2.5 of the wave-8 architecture. One test per row, band and role, each named for its row.

import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ROADMAP_VERBS } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('capabilitiesChrome');

const everyWidth = [320, 390, 744, 1440];
const phones = [320, 390];
const wide = [744, 1440];
const bothRoles = ['owner', 'reader'];

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
}

for (const width of wide) {
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
}

for (const width of everyWidth) {
  hostTest(`§2.5 Switch roadmap · Plant · Planted in public: a reader has no roadmap switcher at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'reader' });
    try {
      assert.equal(await page.locator('.st-roadmap-title-button, .st-roadmap-switcher').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
