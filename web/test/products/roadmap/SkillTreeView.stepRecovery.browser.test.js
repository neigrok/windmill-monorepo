import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { REFUSED_CAPACITY, REFUSED_SYNC, STEP_DETAIL, discardChanges, refusedSyncBody } from '../../../src/products/roadmap/copy.js';

startRoadmapHost({ browserTypes: { chromium, webkit } });

for (const options of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 390, height: 600 },
  { width: 744, height: 960 },
  { width: 744, height: 960, expanded: true },
  { width: 1440, height: 960 },
]) {
  for (const theme of ['light', 'dark']) {
    hostTest(`Chromium: ${theme} recovery reserves its height and pins Undo at ${JSON.stringify(options)}`, async () => {
      const workspace = { wind: { note: 'Watch the water before each sail.\n\n'.repeat(40), subtasks: [], links: [] } };
      const { page, errors } = await openHost({ ...options, shell: true, fixedClock: true, workspace });
      try {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          window.scene.activate('wind');
        }, theme);
        if (options.expanded) await page.getByRole('button', { name: 'Expand Coach' }).click();
        await page.getByRole('button', { name: 'Complete', exact: true }).click();
        await page.mouse.move(0, 0);
        await page.clock.runFor(300);
        await page.evaluate(() => {
          const session = window.session;
          session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
          session.inFlight.set('refused-structure', session.lattice.toFrame());
          session.receiveReject({ frameId: 'refused-structure', code: 'server-error' });
        });
        const alert = page.getByRole('alert');
        await alert.waitFor();
        await page.evaluate(async () => {
          await Promise.all([...document.querySelectorAll('.st-step-read-shell *')].filter((node) => node.getClientRects().length && node.textContent.trim()).map((node) => {
            const style = getComputedStyle(node);
            return document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
          }));
          await document.fonts.ready;
          for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect.getTiming().iterations)) animation.finish();
        });
        await page.clock.runFor(100);
        assert.equal(await alert.count(), 1);
        const before = await page.locator('.st-step-document').evaluate((article) => {
          const box = (selector) => article.querySelector(selector).getBoundingClientRect().toJSON();
          return { toolbar: box('.st-step-toolbar'), notice: box('[role="alert"]'), scroll: box('.st-step-document-scroll'), actions: box('.st-step-pinned-actions') };
        });
        assert.equal(before.notice.top >= before.toolbar.bottom, true);
        assert.equal(before.scroll.top >= before.notice.bottom, true);
        assert.equal(before.scroll.height > 100, true);
        assert.equal(before.scroll.bottom <= before.actions.top, true);
        assert.equal(before.actions.bottom <= options.height, true);
        assert.equal(await alert.evaluate((node) => getComputedStyle(node).flexDirection), options.width < 600 || options.expanded ? 'column' : 'row');
        await page.locator('.st-step-document-scroll').evaluate((node) => { node.scrollTop = node.scrollHeight; });
        assert.equal(await page.locator('.st-step-document-scroll').evaluate((node) => node.scrollTop > 0), true);
        assert.deepEqual(await page.locator('.st-step-pinned-actions').evaluate((node) => node.getBoundingClientRect().toJSON()), before.actions);
        assert.deepEqual(await page.locator('.st-step-toolbar > button:last-child, .st-step-refusal button, .st-step-pinned-actions button').evaluateAll((buttons) => buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return box.width >= 44 && box.height >= 44 && button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        })), [true, true, true, true, true]);
        await page.getByRole('button', { name: STEP_DETAIL.close, exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await alert.getByRole('button', { name: REFUSED_SYNC.retry, exact: true }).evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.getByRole('button', { name: 'Edit kind', exact: true }).evaluate((node) => node === document.activeElement), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

for (const browserName of ['chromium', 'webkit']) {
  hostTest(`${browserName}: Retry returns to the heading and a second refusal retains the same Board document`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, surface: 'board' });
    try {
      await page.locator('.st-board-card[data-step-id="wind"]').click();
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      await page.getByRole('article', { name: 'Read gusts', exact: true }).waitFor();
      await page.evaluate(() => {
        const session = window.session;
        session.inFlight.set('first-refusal', session.lattice.toFrame());
        session.receiveReject({ frameId: 'first-refusal', code: 'server-error' });
      });
      const alert = page.getByRole('alert');
      await alert.getByRole('button', { name: REFUSED_SYNC.retry, exact: true }).click();
      await alert.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.st-board-step-identity-title'));
      await page.evaluate(() => {
        const session = window.session;
        session.inFlight.set('second-refusal', session.lattice.toFrame());
        session.receiveReject({ frameId: 'second-refusal', code: 'bad-frame' });
      });
      await alert.waitFor();
      assert.equal(await page.getByRole('article', { name: 'Read gusts', exact: true }).count(), 1);
      assert.deepEqual(await alert.getByRole('button').allTextContents(), [REFUSED_SYNC.discard, REFUSED_SYNC.retry]);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_refused')), [
        { name: 'roadmap_sync_refused', props: { step: 'shown', lane: 'structure', code: 'server-error' } },
        { name: 'roadmap_sync_refused', props: { step: 'retry', lane: 'structure', code: 'server-error' } },
      ]);
      assert.deepEqual(await page.evaluate(() => window.issues.map(({ operation, tags }) => ({ operation, tags }))), [
        { operation: 'roadmap-sync-refused', tags: { code: 'server-error' } },
        { operation: 'roadmap-sync-refused', tags: { code: 'bad-frame' } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const confirmed of [false, true]) {
  hostTest(`Chromium: structure Discard preserves ${confirmed ? 'confirmed' : 'pending'} completion, Undo focus and private Workspace`, async () => {
    const workspace = { wind: { note: 'Private preparation note', subtasks: [{ id: 'private', label: 'Private task', done: false }], links: [] } };
    const { page, errors } = await openHost({ width: 390, fixedClock: true, workspace });
    try {
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      await page.clock.runFor(300);
      await page.evaluate((confirmed) => {
        const session = window.session;
        if (confirmed) session.receiveProgress(session.progress.toFrame());
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('refused-structure', session.lattice.toFrame());
        session.receiveReject({ frameId: 'refused-structure', code: 'bad-frame' });
      }, confirmed);
      assert.equal(await page.evaluate(() => window.session.statusSnapshot().progressPending > 0), !confirmed);
      await page.getByRole('alert').getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.st-board-step-undo'));
      await page.waitForFunction(() => !window.session.discardPending && window.session.rebaselining?.has('structure'));
      assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), true);
      await page.evaluate(() => window.session.receiveState({ ...window.serverTree, seq: 2 }));
      await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
      await page.locator('.st-board-step-undo').click();
      await page.waitForFunction(() => !window.session.progress.overlay().completed.has('wind'));
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
      assert.equal(await page.evaluate(() => JSON.stringify([window.events, window.issues]).includes('Private')), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: capacity counts refused gestures and offers only Discard inside the editor', async () => {
  const { page, errors } = await openHost({ width: 320 });
  try {
    await page.evaluate(() => {
      window.scene.activate('wind');
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.dispatch({ kind: 'RenameNode', id: 'dock', label: 'Leave harbour' });
      session.inFlight.set('capacity', session.lattice.toFrame());
      session.receiveReject({ frameId: 'capacity', code: 'tree-too-large' });
    });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.equal(await alert.locator('p').textContent(), REFUSED_CAPACITY.title + ' ' + refusedSyncBody({ count: 2 }));
    assert.deepEqual(await alert.getByRole('button').allTextContents(), [discardChanges({ count: 2 })]);
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    await alert.getByRole('button').click();
    await alert.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.st-board-step-identity-title'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a slow failed Discard retains the notice, then a successful Discard respects nested edit focus', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => {
      window.scene.activate('wind');
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('refused', session.lattice.toFrame());
      session.receiveReject({ frameId: 'refused', code: 'bad-frame' });
      const replace = session.store.replaceLane.bind(session.store);
      session.store.replaceLane = (...args) => new Promise((resolve, reject) => {
        window.finishReplacement = (outcome) => {
          if (outcome === 'failure') reject(new Error('Private storage failure'));
          else resolve(outcome === 'success' ? replace(...args) : { status: 'unavailable' });
        };
      });
    });
    const alert = page.getByRole('alert');
    await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    assert.deepEqual(await alert.getByRole('button').evaluateAll((buttons) => buttons.map((node) => node.disabled)), [true, true]);
    await page.evaluate(() => window.finishReplacement('unavailable'));
    await page.waitForFunction(() => !document.querySelector('.st-step-refusal button')?.disabled);
    assert.deepEqual(await alert.getByRole('button').allTextContents(), [REFUSED_SYNC.discard, REFUSED_SYNC.retry]);
    assert.equal(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_sync_refused' && props.step === 'discard').length), 0);
    await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    await page.evaluate(() => window.finishReplacement('failure'));
    await page.waitForFunction(() => !document.querySelector('.st-step-refusal button')?.disabled);
    assert.deepEqual(await page.evaluate(() => window.issues), [
      { operation: 'roadmap-sync-refused', stack: true, tags: { code: 'bad-frame' } },
      { operation: 'roadmap-sync-discard', stack: true },
    ]);
    await alert.getByRole('button', { name: REFUSED_SYNC.discard, exact: true }).click();
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    const dialog = page.locator('.st-inline-field');
    await dialog.waitFor();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Draft kept open');
    await page.evaluate(() => window.finishReplacement('success'));
    await page.locator('.st-step-refusal').waitFor({ state: 'detached' });
    assert.equal(await dialog.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Draft kept open');
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const close of ['Cancel', 'Save']) {
  hostTest(`Chromium: nested edit ${close} keeps unresolved recovery and restores its opener`, async () => {
    const { page, errors } = await openHost({ width: 744, shell: true });
    try {
      await page.evaluate(() => {
        window.scene.activate('wind');
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('refused', session.lattice.toFrame());
        session.receiveReject({ frameId: 'refused', code: 'server-error' });
      });
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      const dialog = page.locator('.st-inline-field');
      await dialog.waitFor();
      assert.equal(await page.locator('.st-step-refusal').evaluate((node) => Boolean(node.closest('[inert]'))), false);
      assert.equal(await page.locator('.st-step-refusal').evaluate((node) => node.querySelector('[role="alert"]') !== null), true);
      if (close === 'Save') await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Watch the water.');
      await page.getByRole('button', { name: close, exact: true }).filter({ visible: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit name');
      const count = close === 'Save' ? 2 : 1;
      await page.getByRole('alert').getByRole('button', { name: discardChanges({ count }), exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').locator('p').textContent(), refusedSyncBody({ count }));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const options of [{ role: 'reader' }, { role: 'owner', address: '#/t/', auth: 'signed-in' }, { demo: true }]) {
  hostTest(`Chromium: the reader document has no owner recovery for ${JSON.stringify(options)}`, async () => {
    const { page, errors } = await openHost(options);
    try {
      await page.evaluate(() => {
        window.scene.activate('wind');
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('refused', session.lattice.toFrame());
        session.receiveReject({ frameId: 'refused', code: 'bad-frame' });
      });
      await page.getByRole('article').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.locator('.st-step-refusal').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_refused')), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const destination of ['Coach', 'TreePicker']) {
  hostTest(`Chromium: a refusal draining respects a later move to ${destination}`, async () => {
    const { page, errors } = await openHost({ width: 744 });
    try {
      await page.evaluate(() => {
        window.scene.activate('wind');
        const session = window.session;
        session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
        session.inFlight.set('refused', session.lattice.toFrame());
        session.receiveReject({ frameId: 'refused', code: 'bad-frame' });
      });
      await page.getByRole('alert').getByRole('button', { name: REFUSED_SYNC.retry, exact: true }).focus();
      if (destination === 'Coach') {
        await page.getByRole('button', { name: 'Expand Coach' }).focus();
      } else {
        await page.getByRole('button', { name: 'Attach a tree', exact: true }).click();
        await page.getByRole('dialog', { name: 'Attach a tree', exact: true }).waitFor();
        assert.equal(await page.locator('.st-step-refusal').evaluate((node) => Boolean(node.closest('[inert]'))), true);
      }
      await page.evaluate(() => {
        const session = window.session;
        session.inFlight.set('drained', session.lattice.toFrame());
        session.receiveAck({ frameId: 'drained' });
      });
      await page.locator('.st-step-refusal').waitFor({ state: 'detached' });
      if (destination === 'Coach') {
        assert.equal(await page.getByRole('button', { name: 'Expand Coach' }).evaluate((node) => node === document.activeElement), true);
      } else {
        assert.equal(await page.getByRole('dialog', { name: 'Attach a tree', exact: true }).evaluate((node) => node.contains(document.activeElement)), true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Attach a tree');
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: a visible refusal follows Coach width without reopening the document or announcing a second episode', async () => {
  const { page, errors } = await openHost({ width: 744 });
  try {
    await page.evaluate(() => {
      window.scene.activate('wind');
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('refused', session.lattice.toFrame());
      session.receiveReject({ frameId: 'refused', code: 'bad-frame' });
    });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    await alert.evaluate((node) => { window.originalNotice = node; });
    await page.getByRole('button', { name: 'Expand Coach' }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-step-refusal [role="alert"]')).flexDirection === 'column');
    assert.equal(await page.locator('.st-step-document').evaluate((node) => node.clientWidth), 464);
    await page.getByRole('button', { name: 'Collapse Coach' }).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.st-step-refusal [role="alert"]')).flexDirection === 'row');
    assert.equal(await alert.evaluate((node) => node === window.originalNotice), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_sync_refused')), [
      { name: 'roadmap_sync_refused', props: { step: 'shown', lane: 'structure', code: 'bad-frame' } },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const action of ['Complete', 'Reset']) {
  hostTest(`Chromium: progress Discard disables ${action} through baseline acceptance and removes its invalid outcome`, async () => {
    const { page, errors } = await openHost({ width: 744, fixedClock: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Complete', exact: true }).click();
      if (action === 'Reset') {
        await page.evaluate(() => {
          window.serverProgress = window.session.progress.toFrame();
          window.session.receiveProgress(window.serverProgress);
        });
        await page.getByRole('button', { name: 'Reset', exact: true }).click();
      }
      await page.evaluate(() => {
        const session = window.session;
        session.progressInFlight.set('progress-refused', session.progress.toFrame());
        session.receiveReject({ frameId: 'progress-refused', code: 'bad-frame' });
        const replace = session.store.replaceLane.bind(session.store);
        session.store.replaceLane = (...args) => new Promise((resolve) => {
          window.finishReplacement = () => resolve(replace(...args));
        });
      });
      await page.getByRole('alert').getByRole('button', { name: /^Discard/ }).click();
      const button = page.getByRole('button', { name: action, exact: true });
      assert.equal(await page.evaluate(() => window.session.discardPending), true);
      assert.equal(await button.isDisabled(), true);
      assert.equal(await page.locator('.st-board-step-outcome').textContent(), '');
      assert.equal(await page.locator('.st-board-step-undo').count(), 0);
      const events = await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_step_action'));
      await button.evaluate((node) => node.click());
      await page.evaluate(() => window.finishReplacement());
      await page.waitForFunction(() => !window.session.discardPending);
      assert.equal(await page.evaluate(() => window.session.rebaselining.has('progress')), true);
      assert.equal(await button.isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_step_action')), events);
      await page.evaluate(() => window.session.receiveProgressGraft(window.serverProgress));
      await page.waitForFunction(() => !window.session.rebaselining);
      assert.equal(await button.isDisabled(), false);
      assert.equal(await page.locator('.st-board-step-outcome').textContent(), '');
      assert.equal(await page.locator('.st-board-step-status-label').textContent(), action === 'Complete' ? 'Up next' : 'Done');
      await button.click();
      assert.equal(await page.locator('.st-board-step-status-label').textContent(), action === 'Complete' ? 'Done' : 'Up next');
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_board_step_action')), [
        ...events, { name: 'roadmap_board_step_action', props: { surface: 'document', action: action.toLowerCase() } },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: progress Discard blocks a still-valid completion Undo until its baseline arrives', async () => {
  const { page, errors } = await openHost({ width: 744, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.evaluate(() => {
      const session = window.session;
      window.serverProgress = session.progress.toFrame();
      session.receiveProgress(window.serverProgress);
      session.markProgress('dock', 'complete');
      session.progressInFlight.set('progress-refused', session.progress.toFrame());
      session.receiveReject({ frameId: 'progress-refused', code: 'bad-frame' });
      const replace = session.store.replaceLane.bind(session.store);
      session.store.replaceLane = (...args) => new Promise((resolve) => {
        window.finishReplacement = () => resolve(replace(...args));
      });
    });
    await page.getByRole('alert').getByRole('button', { name: /^Discard/ }).click();
    const undo = page.locator('.st-board-step-undo');
    assert.equal(await undo.isDisabled(), true);
    await undo.evaluate((node) => node.click());
    await page.evaluate(() => window.finishReplacement());
    await page.getByRole('alert').waitFor({ state: 'detached' });
    assert.equal(await undo.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), true);
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_board_step_action' && props.action === 'undo')), []);
    await page.evaluate(() => window.session.receiveProgressGraft(window.serverProgress));
    assert.equal(await undo.isDisabled(), false);
    await undo.click();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: structure Discard still accepts completion while replacement is pending', async () => {
  const workspace = { wind: { note: 'Private preparation note', subtasks: [], links: [] } };
  const { page, errors } = await openHost({ width: 744, fixedClock: true, workspace });
  try {
    await page.evaluate(() => {
      window.scene.activate('wind');
      const session = window.session;
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('structure-refused', session.lattice.toFrame());
      session.receiveReject({ frameId: 'structure-refused', code: 'bad-frame' });
      const replace = session.store.replaceLane.bind(session.store);
      session.store.replaceLane = (...args) => new Promise((resolve) => {
        window.finishReplacement = () => resolve(replace(...args));
      });
    });
    await page.getByRole('alert').getByRole('button', { name: /^Discard/ }).click();
    const complete = page.getByRole('button', { name: 'Complete', exact: true });
    assert.equal(await complete.isDisabled(), false);
    await complete.click();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), true);
    await page.evaluate(() => window.finishReplacement());
    await page.getByRole('alert').waitFor({ state: 'detached' });
    await page.evaluate(() => window.session.receiveState({ ...window.serverTree, seq: 2 }));
    assert.equal(await page.locator('.st-board-step-status-label').textContent(), 'Done');
    await page.locator('.st-board-step-undo').click();
    assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has('wind')), false);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('windmill:workspace:t_sail'))), workspace);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [744, 1440]) {
  for (const action of ['Complete', 'Reset']) {
    hostTest(`Chromium: the ${width}px Graph naming handoff reports ${action} only after progress accepts it`, async () => {
      const { page, errors } = await openHost({ width: 1440 });
      try {
        await page.evaluate((action) => {
          window.createdStep = window.scene.options.onCreateChild('course').id;
          if (action === 'Reset') {
            window.session.markProgress(window.createdStep, 'complete');
            window.session.emitProjection('progress');
          }
          window.session.rebaselining = new Set(['progress']);
          window.session.emitStatus();
        }, action);
        await page.setViewportSize({ width, height: 1000 });
        const label = width === 744 ? action === 'Complete' ? 'Mark done' : 'Mark not done' : action;
        const button = page.getByRole('button', { name: label, exact: true }).filter({ visible: true });
        await button.click();
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => ['roadmap_board_complete', 'roadmap_board_step_action'].includes(name))), []);
        assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has(window.createdStep)), action === 'Reset');
        await page.evaluate(() => window.session.receiveProgressGraft(window.serverProgress));
        await button.click();
        assert.equal(await page.evaluate(() => window.session.progress.overlay().completed.has(window.createdStep)), action === 'Complete');
        const surface = width === 744 ? 'panel' : 'dock';
        assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => ['roadmap_board_complete', 'roadmap_board_step_action'].includes(name))), [action === 'Complete'
          ? { name: 'roadmap_board_complete', props: { door: surface } }
          : { name: 'roadmap_board_step_action', props: { surface, action: 'reset' } }]);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}
