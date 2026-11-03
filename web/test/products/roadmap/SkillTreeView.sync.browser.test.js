import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { REFUSED_SYNC, SYNC_STATUS, ANONYMOUS_OWNER, LAPSED_SESSION } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost('sync');

hostTest('Chromium: the device-only Graph keeps its Shell honesty line and sign-in reachable at 744px', async () => {
  const { page, errors } = await openHost({ width: 744, role: 'ghost', shell: true });
  try {
    const line = page.locator('.wm-room-status-full');
    await page.getByRole('status').filter({ hasText: ANONYMOUS_OWNER }).waitFor();
    assert.equal(await line.textContent(), ANONYMOUS_OWNER);
    assert.equal(await page.locator('.st-roadmap-device-nudge').count(), 0);
    await page.waitForFunction(() => {
      const notice = document.querySelector('.wm-room-status-full')?.getBoundingClientRect();
      const camera = document.querySelector('.st-mobile-chrome [aria-label="Camera"]')?.getBoundingClientRect();
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
        const camera = document.querySelector('.st-mobile-chrome [aria-label="Camera"]')?.getBoundingClientRect();
        return notice && camera && (camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left);
      });
      assert.equal(await page.locator('.st-roadmap-device-nudge').evaluate((element) => {
        const notice = element.getBoundingClientRect();
        const camera = document.querySelector('.st-mobile-chrome [aria-label="Camera"]').getBoundingClientRect();
        return camera.top >= notice.bottom || camera.bottom <= notice.top || camera.left >= notice.right || camera.right <= notice.left;
      }), true);
      assert.equal(await page.locator('.st-roadmap-device-nudge').evaluate((element) => element.getBoundingClientRect().left), 16);
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
      await page.locator('.wm-room-status').waitFor();
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
        window.session.ackedServerVector = window.session.lattice.frontier();
        window.session.emitStatus();
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

for (const options of [{ role: 'reader' }, { role: 'ghost' }, { demo: true }, { gate: 'closed' }]) {
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
          assert.equal(await page.locator('.wm-room-status').count(), 0);
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

for (const width of [320, 390, 744, 1440]) {
  for (const surface of ['tree', 'board']) {
    hostTest(`Chromium: real refusal surface retries, discards and restores focus at ${width}px on ${surface}`, async () => {
      const { page, errors } = await openHost({ width, surface, shell: true });
      try {
        if (surface === 'tree' && width < 744) await page.evaluate(() => window.scene.select('wind'));
        await page.evaluate(() => {
          const session = window.session;
          session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
          session.inFlight.set('fixture-refused', session.lattice.frontier());
          session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
        });
        const alert = page.getByRole('alert');
        await alert.waitFor();
        assert.equal(await alert.getByText(REFUSED_SYNC.body, { exact: true }).count(), 1);
        if (surface === 'tree' && width < 744) {
          await page.waitForFunction(() => {
            const card = document.querySelector('.st-graph-refusal')?.getBoundingClientRect();
            let sheetRoot = document.querySelector('.st-step-name');
            while (sheetRoot && getComputedStyle(sheetRoot).position !== 'fixed') sheetRoot = sheetRoot.parentElement;
            const sheet = sheetRoot?.getBoundingClientRect();
            return card && sheet && card.bottom <= sheet.top && window.cameraInsets.bottom >= window.innerHeight - card.top;
          });
          assert.equal(await page.locator('.st-graph-refusal').evaluate((element) => {
            const card = element.getBoundingClientRect();
            let sheetRoot = document.querySelector('.st-step-name');
            while (sheetRoot && getComputedStyle(sheetRoot).position !== 'fixed') sheetRoot = sheetRoot.parentElement;
            const sheet = sheetRoot.getBoundingClientRect();
            return card.bottom <= sheet.top;
          }), true);
        }

        await alert.getByRole('button', { name: 'Retry', exact: true }).click();
        await alert.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement !== document.body);
        assert.equal(await page.evaluate(() => window.reconnects), 1);
        await page.evaluate(() => {
          const session = window.session;
          session.inFlight.set('fixture-refused-again', session.lattice.frontier());
          session.receiveReject({ frameId: 'fixture-refused-again', code: 'server-error' });
        });
        await alert.waitFor();
        await alert.getByRole('button', { name: 'Discard change', exact: true }).click();
        await alert.waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement !== document.body);
        await page.evaluate(() => window.session.receiveState({ ...window.serverTree, intent: 'delta' }));
        await page.waitForFunction(() => window.session.ready);
        assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'wind').label), 'Read the wind');
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_refused')), [
          { name: 'roadmap_sync_refused', props: { step: 'shown', lane: 'structure', code: 'server-error' } },
          { name: 'roadmap_sync_refused', props: { step: 'retry', lane: 'structure', code: 'server-error' } },
          { name: 'roadmap_sync_refused', props: { step: 'discard', lane: 'structure', code: 'server-error' } },
        ]);
        assert.deepEqual(await page.evaluate(() => window.issues), [{ operation: 'roadmap-sync-refused', stack: true, tags: { code: 'server-error' } }]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

hostTest('Chromium: discarding a Graph create dismisses its invalidated Undo toast', async () => {
  const { page, errors } = await openHost();
  try {
    await page.locator('.st-roadmap-identity').getByRole('button', { name: 'New step', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Practice knots');
    await page.getByRole('button', { name: 'Create step', exact: true }).click();
    await page.locator('.st-graph-toast').waitFor();
    await page.evaluate(() => {
      const session = window.session;
      session.inFlight.set('fixture-create', session.lattice.frontier());
      session.receiveReject({ frameId: 'fixture-create', code: 'bad-frame' });
    });
    await page.getByRole('alert').getByRole('button', { name: /^Discard/ }).click();
    await page.locator('.st-graph-toast').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.session.receiptVersion), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [390, 1440]) {
  hostTest(`Chromium: Graph refusal drain returns focus to the displayed view switch at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => {
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('fixture-refused', session.lattice.frontier());
        session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
      });
      const alert = page.getByRole('alert');
      await alert.getByRole('button', { name: 'Retry', exact: true }).focus();
      await page.evaluate(() => {
        const session = window.session;
        session.ackedServerVector = session.lattice.frontier();
        session.emitStatus();
      });
      await alert.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.st-roadmap-identity .st-board-switch-option[aria-pressed="true"]'));
      assert.equal(await page.locator('.st-roadmap-identity .st-board-switch-option[aria-pressed="true"]').evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const width of [744, 900, 1024, 1280, 1440]) {
  hostTest(`Chromium: Graph refusal clears the selected-step dock at ${width}px`, async () => {
    const { page, errors } = await openHost({ width });
    try {
      await page.evaluate(() => window.scene.select('wind'));
      await page.locator('.st-detail-panel--open').waitFor();
      await page.evaluate(() => {
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('fixture-refused', session.lattice.frontier());
        session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
      });
      await page.getByRole('alert').getByText(REFUSED_SYNC.body, { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const refusal = document.querySelector('.st-graph-refusal').getBoundingClientRect();
        const dock = document.querySelector('.st-detail-panel--open').getBoundingClientRect();
        return dock.top >= refusal.bottom;
      });
      assert.deepEqual(await page.getByRole('alert').getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { name: button.textContent.trim(), reachable: button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
      })), [{ name: REFUSED_SYNC.discard, reachable: true }, { name: REFUSED_SYNC.retry, reachable: true }]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: a structure discard preserves the Graph completion Undo', async () => {
  const { page, errors } = await openHost({ fixedClock: true });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.locator('.st-graph-toast .st-board-toast-undo').waitFor();
    await page.evaluate(() => {
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('fixture-refused', session.lattice.frontier());
      session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
    });
    await page.getByRole('alert').getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await page.evaluate(() => window.session.receiveState({ ...window.serverTree, seq: 2 }));
    await page.waitForFunction(() => window.session.ready);
    await page.locator('.st-graph-toast .st-board-toast-undo').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
