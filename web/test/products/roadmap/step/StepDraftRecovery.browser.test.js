import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from '../skillTreeViewHost.js';

startRoadmapHost();

for (const width of [320, 390, 744, 1440]) {
  hostTest(`unknown native navigation retains one copyable field above the destination at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, height: 844, shell: true, draftNavigation: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Edit description', exact: true }).click();
      await page.getByRole('textbox', { name: 'Description', exact: true }).fill('My retained words');
      await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
      await page.getByRole('heading', { name: 'Destination' }).waitFor();
      assert.equal(await page.locator('.st-draft-notice').innerText(), 'Roadmap draft\nNot saved\nView draft');
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.locator('.st-draft-notice').evaluate((node) => node.getBoundingClientRect().height), 64);
      assert.equal(await page.getByRole('heading', { name: 'Destination' }).evaluate((node) => node.getBoundingClientRect().top >= 64), true);
      await page.getByRole('button', { name: 'View draft', exact: true }).click();
      await page.getByRole('dialog', { name: 'Roadmap draft', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'My retained words');
      await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
      await page.getByText('Copied. Your draft is still not saved.', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copied), ['My retained words']);
      assert.equal(await page.locator('#root').evaluate((node) => node.inert), true);
      await page.getByRole('dialog', { name: 'Roadmap draft', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.textContent === 'View draft');
      assert.equal(await page.evaluate(() => window.draftStore.getSnapshot().mode), 'retained');
      await page.getByRole('button', { name: 'View draft', exact: true }).click();
      await page.getByRole('button', { name: 'Return to step', exact: true }).click();
      await page.getByRole('textbox', { name: 'Description', exact: true }).waitFor();
      await page.waitForFunction(() => window.draftStore.getSnapshot()?.mode === 'active');
      assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'My retained words');
      assert.equal(await page.locator('.st-draft-notice').count(), 0);
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').description ?? ''), '');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('retained draft blocks collisions and voluntary sign-out; forced owner replacement clears content', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, draftNavigation: true });
  try {
    const route = page.url();
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Account A only');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).waitFor();
    await page.evaluate(() => { window.fixtureSignOut(); });
    await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
    assert.equal(await page.evaluate(() => window.signOuts ?? 0), 0);
    await page.evaluate((route) => { window.previousScene = window.scene; window.fixtureNavigate(route); }, route);
    await page.waitForFunction(() => !window.session?.closed && window.session?.ready && window.scene !== window.previousScene);
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('dialog', { name: 'Roadmap draft', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Account A only');
    assert.equal(await page.locator('#root').evaluate((node) => node.inert), true);
    await page.getByRole('dialog', { name: 'Roadmap draft', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit name');
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => window.draftScope.begin({ kind: 'account', id: 'B' }));
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('.st-draft-notice').count(), 0);
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot()), null);
    assert.equal(await page.locator('body').innerText().then((text) => text.includes('Account A only')), false);
    assert.deepEqual(await page.evaluate(() => window.copied), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('permission or deletion loss retains selectable text with no Save and no protected refetch', async () => {
  for (const loss of ['permission', 'deletion']) {
    const { page, errors, requests } = await openHost({ width: 390, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep this text');
      const before = requests.length;
      await page.evaluate((loss) => {
        if (loss === 'deletion') window.session.dispatch({ kind: 'BulkDelete', nodeIds: ['wind'] });
        else window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } }));
      }, loss);
      await page.getByText('Editing is unavailable. Copy your draft or discard it.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Keep this text');
      await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
      await page.waitForFunction(() => window.copied.length === 1);
      assert.deepEqual(await page.evaluate(() => window.copied), ['Keep this text']);
      assert.equal(requests.length, before);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

hostTest('clipboard refusal preserves selectable text; retained sign-out Discard runs exactly once', async () => {
  const { page, errors } = await openHost({ width: 320, shell: true, draftNavigation: true, clipboardRefused: true });
  try {
    await page.evaluate(() => { window.fixtureTheme('dark'); window.scene.activate('wind'); });
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Copy by hand');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Roadmap draft', exact: true });
    await dialog.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await page.getByText('Copy failed. Select the text or try again.', { exact: true }).waitFor();
    await page.locator('.st-draft-copy').getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Select text', exact: true }).click();
    assert.equal(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_step_draft' && props.step === 'copy_failed').length), 2);
    assert.deepEqual(await page.getByRole('textbox', { name: 'Description', exact: true }).evaluate((node) => [node.value, node.selectionStart, node.selectionEnd, node.readOnly]), ['Copy by hand', 0, 12, true]);
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    if (process.env.WM_INLINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/recovery-dark-320-copy-failed.png` });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => { window.fixtureSignOut(); window.fixtureSignOut(); });
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => window.signOuts === 1);
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot()), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('return to a deleted step keeps recovery copyable and cannot save', async () => {
  const { page, errors } = await openHost({ width: 744, shell: true, draftNavigation: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep a deleted step draft');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => { window.fixture.nodes = window.fixture.nodes.filter((node) => node.id !== 'wind').map((node) => ({ ...node, prerequisites: node.prerequisites.filter((id) => id !== 'wind') })); });
    await page.getByRole('button', { name: 'Return to step', exact: true }).click();
    await page.getByText('Editing is unavailable. Copy your draft or discard it.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Keep a deleted step draft');
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot().mode), 'retained');
    await page.getByRole('button', { name: 'Copy draft', exact: true }).last().click();
    await page.waitForFunction(() => window.copied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copied), ['Keep a deleted step draft']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('late clipboard completion cannot expose a cleared account draft or steal focus', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, draftNavigation: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Account A secret');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise((resolve) => { window.finishDraftCopy = resolve; }); });
    await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await page.evaluate(() => {
      const ticket = window.draftScope.begin({ kind: 'account', id: 'B' });
      window.draftScope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'bound', account: 'B' } } } }, ticket);
    });
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'Destination' }).evaluate((node) => { node.tabIndex = -1; node.focus(); });
    await page.evaluate(() => window.finishDraftCopy());
    assert.equal(await page.getByRole('heading', { name: 'Destination' }).evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.locator('body').innerText().then((text) => text.includes('Account A secret')), false);
    assert.equal(await page.evaluate(() => JSON.stringify([window.events, window.issues]).includes('Account A secret')), false);
    assert.equal(await page.locator('.st-draft-notice').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('an unmatched return keeps recovery for Retry and clears only after matching editor adoption', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, draftNavigation: true, fixedClock: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Retry this return');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => {
      const slot = window.draftStore.getSnapshot();
      window.savedDraftRoute = slot.route;
      window.draftStore.update(slot.token, { route: { ...slot.route, hash: '#/app/t_sail?step=dock' } });
    });
    await page.getByRole('button', { name: 'Return to step', exact: true }).click();
    await page.waitForFunction(() => location.hash.includes('step=dock'));
    await page.clock.runFor(10001);
    await page.getByText('Couldn’t return to this step. Your draft is still here. Try again.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Retry this return');
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot().mode), 'retained');
    assert.deepEqual(await page.evaluate(() => window.issues.map(({ operation }) => operation)), ['roadmap-step-draft-return']);
    await page.evaluate(() => { const slot = window.draftStore.getSnapshot(); window.draftStore.update(slot.token, { route: window.savedDraftRoute }); });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(() => window.draftStore.getSnapshot()?.mode === 'active');
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Retry this return');
    assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find(({ id }) => id === 'wind').description ?? ''), '');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('reopening recovery gives a newer clipboard attempt ownership of its result', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, draftNavigation: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Two copy attempts');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => { window.copyResolvers = []; navigator.clipboard.writeText = () => new Promise((resolve) => window.copyResolvers.push(resolve)); });
    const dialog = page.getByRole('dialog', { name: 'Roadmap draft', exact: true });
    await dialog.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await dialog.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await page.evaluate(() => window.copyResolvers[0]());
    assert.equal(await dialog.getByRole('button', { name: 'Copy draft', exact: true }).isDisabled(), true);
    assert.equal(await page.getByText('Copied. Your draft is still not saved.', { exact: true }).count(), 0);
    await page.evaluate(() => window.copyResolvers[1]());
    await page.getByText('Copied. Your draft is still not saved.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_step_draft' && props.step === 'copied').length), 2);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('cancelling recovery discard restores focus to its surviving button', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, draftNavigation: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep this recovery');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    const recovery = page.getByRole('dialog', { name: 'Roadmap draft', exact: true });
    for (const cancel of ['button', 'escape', 'backdrop']) {
      await recovery.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('button', { name: 'Keep draft', exact: true }).waitFor();
      if (cancel === 'button') await page.getByRole('button', { name: 'Keep draft', exact: true }).click();
      else if (cancel === 'escape') await page.keyboard.press('Escape');
      else await page.locator('.st-draft-modal-layer').last().locator('.st-draft-scrim').click({ position: { x: 4, y: 4 } });
      await page.waitForFunction(() => document.activeElement?.textContent === 'Discard' && document.activeElement?.closest('.st-draft-recovery'), null, { timeout: 1000 });
      assert.equal(await recovery.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Keep this recovery');
      assert.equal(await page.evaluate(() => window.draftStore.getSnapshot().mode), 'retained');
    }
    await recovery.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('dialog', { name: 'Discard this draft?', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Destination');
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot()), null);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('.st-draft-notice').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


for (const loss of ['permission', 'deletion']) {
  hostTest(`unavailable Escape guards ${loss} draft text and restores its selection`, async () => {
    const { page, errors, requests } = await openHost({ width: 390, height: 844, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep unavailable text');
      await page.evaluate((loss) => {
        if (loss === 'deletion') window.session.dispatch({ kind: 'BulkDelete', nodeIds: ['wind'] });
        else window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } }));
      }, loss);
      await page.getByText('Editing is unavailable. Copy your draft or discard it.', { exact: true }).waitFor();
      const field = page.getByRole('textbox', { name: 'Name', exact: true });
      await field.focus();
      await field.evaluate((node) => node.setSelectionRange(2, 7));
      const before = requests.length;
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.st-draft-decision').count(), 1);
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.matches('.st-unavailable-draft textarea'));
      assert.deepEqual(await field.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd]), ['Keep unavailable text', 2, 7]);
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 450 });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await page.locator('.st-unavailable-draft footer').evaluate((node) => node.getBoundingClientRect().bottom <= visualViewport.height), true);
      if (process.env.WM_INLINE_SCREENSHOTS && loss === 'deletion') await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/fix-keyboard-unavailable.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.waitForFunction(() => window.draftStore.getSnapshot() === null);
      assert.equal(await page.locator('.st-unavailable-draft').count(), 0);
      assert.equal(requests.length, before);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('retained recovery follows the phone keyboard viewport and keeps its footer visible', async () => {
  const { page, errors } = await openHost({ width: 390, height: 844, shell: true, draftNavigation: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Recover this text');
    await page.evaluate(() => { history.pushState({}, '', '/draft-destination'); history.pushState({}, '', '/transient'); history.back(); });
    await page.getByRole('button', { name: 'View draft', exact: true }).click();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 450 });
      Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 24 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await page.locator('.st-draft-recovery').evaluate((node) => {
      const head = node.querySelector('header').getBoundingClientRect();
      const foot = node.querySelector('footer').getBoundingClientRect();
      return { top: head.top >= visualViewport.offsetTop, bottom: foot.bottom <= visualViewport.offsetTop + visualViewport.height };
    }), { top: true, bottom: true });
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Recover this text');
    if (process.env.WM_INLINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/fix-keyboard-recovery.png` });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
