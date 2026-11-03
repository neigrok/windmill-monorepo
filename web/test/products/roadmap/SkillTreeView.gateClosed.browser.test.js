import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost('gateClosed');

for (const [width, band] of [[390, 'phone'], [744, 'tablet'], [1440, 'desktop']]) {
  for (const role of ['owner', 'reader']) {
    hostTest(`Chromium: gate-closed host keeps legacy ${band} ${role} chrome`, async () => {
      const { page, errors } = await openHost({ width, role, gate: 'closed' });
      try {
        assert.deepEqual(await page.evaluate(() => ({
          identity: document.querySelectorAll('.st-roadmap-identity-host').length,
          topbar: document.querySelectorAll('.st-topbar').length,
          mobile: document.querySelectorAll('.st-mobile-chrome').length,
          camera: document.querySelectorAll('.st-graph-camera').length,
          hash: location.hash,
          gatedEvents: window.events.filter(({ name }) => ['roadmap_graph_find', 'roadmap_graph_toast', 'roadmap_verb', 'roadmap_sheet'].includes(name)),
        })), { identity: 0, topbar: band === 'desktop' && role === 'owner' ? 1 : 0,
          mobile: band === 'desktop' && role === 'owner' ? 0 : 1, camera: 0, hash: '#/app/t_sail', gatedEvents: [] });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const width of [320, 744, 1440]) {
  hostTest(`Chromium: gate-closed refusal retains legacy words and emits no wave-7 telemetry at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, gate: 'closed', shell: true });
    try {
      await page.evaluate(() => {
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('fixture-refused', session.lattice.frontier());
        session.receiveReject({ frameId: 'fixture-refused', code: 'tree-too-large' });
      });
      await page.getByText('Not saving — this roadmap is at its limit', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.locator('.wm-room-status').count(), 0);
      assert.deepEqual(await page.evaluate(() => ({
        events: window.events.filter(({ name }) => ['roadmap_sync_refused', 'roadmap_sync_offline', 'roadmap_device_line'].includes(name)),
        issues: window.issues,
      })), { events: [], issues: [] });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
