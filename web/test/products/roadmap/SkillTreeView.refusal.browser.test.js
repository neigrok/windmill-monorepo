import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { REFUSED_SYNC } from '../../../src/products/roadmap/board/copy.js';

startRoadmapHost();

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
            const sheet = document.querySelector('[data-graph-step-bar]')?.getBoundingClientRect();
            return card && sheet && card.bottom <= sheet.top && window.cameraInsets.bottom >= window.innerHeight - card.top;
          });
          assert.equal(await page.locator('.st-graph-refusal').evaluate((element) => {
            const card = element.getBoundingClientRect();
            const sheet = document.querySelector('[data-graph-step-bar]').getBoundingClientRect();
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
        await page.waitForFunction(() => !window.session.discardPending && window.session.rebaselining?.has('structure'));
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
        session.inFlight.set('fixture-drained', session.lattice.frontier());
        session.structureWrites.set('fixture-drained', session.lattice.toFrame());
        session.receiveAck({ frameId: 'fixture-drained' });
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
    await page.clock.runFor(300);
    await page.locator('.st-graph-toast .st-board-toast-undo').waitFor();
    await page.evaluate(() => {
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('fixture-refused', session.lattice.frontier());
      session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
    });
    await page.getByRole('alert').getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await page.waitForFunction(() => !window.session.discardPending && window.session.rebaselining?.has('structure'));
    await page.evaluate(() => window.session.receiveState({ ...window.serverTree, seq: 2 }));
    await page.waitForFunction(() => window.session.ready);
    await page.locator('.st-graph-toast .st-board-toast-undo').click();
    await page.getByRole('button', { name: 'Complete', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


hostTest('Chromium: one create with a prerequisite counts once and discard clears it before a slow reply', async () => {
  const { page, errors } = await openHost({ width: 390, surface: 'board', shell: true, fixedClock: true });
  try {
    await page.evaluate(() => {
      const session = window.session;
      session.dispatch({ kind: 'CreateNode', id: 'knots', label: 'Practice knots', prerequisites: ['wind'] });
      session.inFlight.set('fixture-create', session.lattice.frontier());
      session.receiveReject({ frameId: 'fixture-create', code: 'bad-frame' });
    });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.equal(await alert.getByText(REFUSED_SYNC.body, { exact: true }).count(), 1);
    assert.equal(await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.session.statusSnapshot().structureGestures), 1);
    await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !window.session.discardPending && window.session.rebaselining?.has('structure'));
    assert.equal(await page.evaluate(() => window.scene.nodesById.has('knots')), false);
    assert.equal(await page.locator('[data-step-id="knots"]').count(), 0);
    await page.clock.runFor(10000);
    assert.equal(await page.evaluate(() => window.roomStatus()), null);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_offline')), []);
    await page.evaluate(() => window.session.receiveState({ ...window.serverTree, seq: 2 }));
    await page.waitForFunction(() => window.session.ready);
    assert.equal(await page.evaluate(() => window.roomStatus()), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
