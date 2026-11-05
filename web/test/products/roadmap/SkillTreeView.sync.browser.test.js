import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { SYNC_STATUS, ANONYMOUS_OWNER, LAPSED_SESSION } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

hostTest('Chromium: the device-only Graph keeps its Shell honesty line and sign-in reachable at 744px', async () => {
  const { page, errors } = await openHost({ width: 744, role: 'ghost', shell: true });
  try {
    const line = page.locator('.wm-room-status-full');
    await page.getByRole('status').filter({ hasText: ANONYMOUS_OWNER }).waitFor();
    assert.equal(await line.textContent(), ANONYMOUS_OWNER);
    assert.equal(await page.locator('.st-roadmap-device-nudge').count(), 0);
    await page.waitForFunction(() => {
      const notice = document.querySelector('.wm-room-status-full')?.getBoundingClientRect();
      const camera = document.querySelector('.st-graph-chrome [aria-label="Camera"]')?.getBoundingClientRect();
      return notice && camera && (camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left);
    });
    assert.equal(await line.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
    }), true);
    await page.locator('.wm-head-sign-in').click();
    assert.equal(await page.evaluate(() => window.signInOpened), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [320, 390]) {
  hostTest(`Chromium: the device-only Graph keeps its device line reachable at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, role: 'ghost' });
    try {
      const nudge = page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true });
      await nudge.waitFor();
      assert.equal(await nudge.count(), 1);
      assert.equal(await nudge.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
      }), true);
      await page.waitForFunction(() => {
        const notice = document.querySelector('.st-roadmap-device-nudge')?.getBoundingClientRect();
        const camera = document.querySelector('.st-graph-chrome [aria-label="Camera"]')?.getBoundingClientRect();
        return notice && camera && (camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left);
      });
      assert.equal(await page.locator('.st-roadmap-device-nudge').evaluate((element) => {
        const notice = element.getBoundingClientRect();
        const camera = document.querySelector('.st-graph-chrome [aria-label="Camera"]').getBoundingClientRect();
        return camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left;
      }), true);
      assert.deepEqual(await nudge.evaluate((element) => ({
        textLeft: element.firstElementChild.getBoundingClientRect().left,
        underIdentity: element.getBoundingClientRect().top === document.querySelector('.st-roadmap-identity').getBoundingClientRect().bottom,
      })), { textLeft: 16, underIdentity: true });
      await nudge.click();
      assert.equal(await page.evaluate(() => window.signInOpened), 1);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [320, 390, 744, 1440]) {
  hostTest(`Chromium: signed-in owner publishes Saving, Saved and Offline to the real Shell at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true, fixedClock: true });
    try {
      await page.locator('.wm-room-status').waitFor({ state: 'attached' });
      await page.evaluate(() => { window.initialStatusRegion = document.querySelector('[role="status"]'); });
      assert.equal(await page.locator('.wm-room-status').count(), 1);
      assert.equal(await page.evaluate(() => window.roomStatus()), null);
      await page.evaluate(() => window.session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' }));
      await page.clock.runFor(299);
      assert.equal(await page.locator('.wm-room-status').count(), 1);
      assert.equal(await page.evaluate(() => window.roomStatus()), null);
      await page.clock.runFor(1);
      await page.getByRole('status').filter({ hasText: SYNC_STATUS.saving }).waitFor();
      await page.evaluate(() => {
        const session = window.session;
        const writes = session.lattice.toFrame();
        session.inFlight.set('fixture-ack', session.lattice.frontier());
        session.structureWrites.set('fixture-ack', writes);
        session.receiveAck({ frameId: 'fixture-ack' });
      });
      await page.getByRole('status').filter({ hasText: SYNC_STATUS.saved }).waitFor();
      await page.clock.runFor(1999);
      assert.equal(await page.getByRole('status').filter({ hasText: SYNC_STATUS.saved }).count(), 1);
      await page.clock.runFor(1);
      await page.waitForFunction(() => window.roomStatus() === null && document.querySelector('[role="status"]')?.textContent === '');
      assert.equal(await page.getByRole('status').textContent(), '');
      await page.evaluate(() => { window.session.online = false; window.session.emitStatus(); });
      await page.getByRole('status').filter({ hasText: SYNC_STATUS.offline }).waitFor();
      const shown = await page.locator('.wm-room-status').evaluate((slot) => {
        const visible = (selector) => getComputedStyle(slot.querySelector(selector)).display !== 'none';
        return { full: visible('.wm-room-status-full'), compact: visible('.wm-room-status-compact'), tap: visible('.wm-room-status-narrow') };
      });
      assert.deepEqual(shown, { full: width >= 744, compact: width >= 360 && width < 744, tap: width < 360 });
      await page.evaluate(() => { window.session.online = true; window.session.emitStatus(); });
      await page.waitForFunction(() => window.roomStatus() === null && document.querySelector('[role="status"]')?.textContent === '');
      assert.equal(await page.getByRole('status').textContent(), '');
      assert.equal(await page.evaluate(() => window.initialStatusRegion === document.querySelector('[role="status"]')), true);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_offline')), [
        { name: 'roadmap_sync_offline', props: { step: 'shown', pending: '0' } },
        { name: 'roadmap_sync_offline', props: { step: 'cleared', pending: '0' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const options of [{ role: 'reader' }, { demo: true }]) {
  hostTest(`Chromium: sync publication is absent outside signed-in owner chrome ${JSON.stringify(options)}`, async () => {
    const { page, errors } = await openHost({ ...options, shell: true, width: 390 });
    try {
      await page.evaluate(() => { window.session.online = false; window.session.emitStatus(); });
      assert.equal(await page.evaluate(() => window.roomStatus()), null);
      assert.equal(await page.locator('.wm-room-status').count(), 0);
      assert.equal(await page.locator('[role="status"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_offline')), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [320, 390, 744, 1440]) {
  for (const surface of ['tree', 'board']) {
    hostTest(`Chromium: anonymous and lapsed device lines use one placement at ${width}px on ${surface}`, async () => {
      const { page, errors } = await openHost({ role: 'ghost', width, surface, shell: true });
      try {
        const line = ANONYMOUS_OWNER;
        if (width < 744) {
          const button = page.getByRole('button', { name: line, exact: true });
          await button.waitFor();
          assert.equal(await button.count(), 1);
          await button.click();
          assert.equal(await page.evaluate(() => window.signInOpened), 1);
          assert.equal(await page.locator('.wm-room-status--device').count(), 1);
          await page.locator('.wm-head-sign-in').click();
          assert.equal(await page.evaluate(() => window.signInOpened), 2);
          assert.equal(await page.locator('.wm-room-status').textContent(), '');
          assert.equal(await button.evaluate((element) => element.firstElementChild.getBoundingClientRect().left), 16);
          assert.equal(await button.evaluate((element) => element.getBoundingClientRect().top),
            await page.locator('.st-roadmap-identity').evaluate((element) => element.getBoundingClientRect().bottom));
        } else {
          await page.getByRole('status').filter({ hasText: line }).waitFor();
          assert.equal(await page.getByRole('button', { name: line, exact: true }).count(), 0);
        }
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_device_line' && props.step === 'shown')),
          [{ name: 'roadmap_device_line', props: { step: 'shown', line: 'anonymous', place: width < 744 ? 'row' : 'shell' } }]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
      const lapsed = await openHost({ width, surface, shell: true });
      try {
        await lapsed.page.evaluate(async () => {
          window.session.receiveReject({ code: 'sign-in-required' });
          await Promise.resolve();
          window.setFixtureAuth('ghost');
        });
        const line = LAPSED_SESSION;
        const notice = width < 744 ? lapsed.page.getByRole('button', { name: line, exact: true }) : lapsed.page.getByRole('status').filter({ hasText: line });
        await notice.waitFor();
        assert.equal(await notice.count(), 1);
        assert.deepEqual(lapsed.errors, []);
      } finally { await lapsed.page.close(); }
    });
  }
}
