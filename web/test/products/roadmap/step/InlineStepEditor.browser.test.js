import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from '../skillTreeViewHost.js';

startRoadmapHost();

for (const width of [320, 390, 744, 1024, 1440]) {
  hostTest(`inline fields preserve sparse saves and their focus targets at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Edit name', exact: true }).waitFor();
      assert.deepEqual(await page.locator('[data-step-field]').evaluateAll((nodes) => nodes.map((node) => ({ field: node.dataset.stepField, target: node.getBoundingClientRect().width >= 44 && node.getBoundingClientRect().height >= 44 }))), ['color', 'label', 'description', 'prerequisites'].map((field) => ({ field, target: true })));
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Read gusts');
      if (process.env.WM_INLINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/inline-light-${width}-name.png` });
      await page.evaluate(() => window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer description', color: 'plum' }));
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      await page.getByRole('button', { name: 'Edit name', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => { const node = window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind'); return { label: node.label, description: node.description, color: node.color, prerequisites: node.prerequisites }; }),
        { label: 'Read gusts', description: 'Peer description', color: 'plum', prerequisites: ['course'] });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit name');
      await page.getByRole('button', { name: 'Edit description', exact: true }).click();
      await page.getByRole('textbox', { name: 'Description', exact: true }).fill('');
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').description ?? ''), '');
      await page.getByRole('button', { name: 'Edit kind', exact: true }).click();
      await page.getByRole('radio', { name: 'Sky', exact: true }).click();
      assert.equal(await page.locator('.st-step-read-tags .st-board-step-status-label').count(), 0);
      assert.deepEqual(await page.getByRole('radio').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height >= 44)), Array(6).fill(true));
      if (process.env.WM_INLINE_SCREENSHOTS && width === 390) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/inline-light-390-kind.png` });
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').color), 'plum');
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      await page.getByRole('button', { name: 'Edit prerequisites', exact: true }).click();
      await page.getByRole('checkbox', { name: /Choose a course/ }).click();
      assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').prerequisites), ['course']);
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      assert.deepEqual(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').prerequisites), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('same-field conflict preserves draft, renews consent, and Load latest updates only that field', async () => {
  const { page, errors } = await openHost({ width: 1440, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('My text');
    await page.evaluate(() => window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer one' }));
    await page.getByText('Latest: Peer one', { exact: true }).waitFor();
    await page.evaluate(() => window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer two' }));
    await page.getByText('Latest: Peer two', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'My text');
    await page.getByRole('button', { name: 'Load latest', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Peer two');
    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    assert.equal(await page.locator('.st-inline-field').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('dirty navigation keeps caret, then admits captured departure once; deleted choices are explained', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Name', exact: true });
    await input.fill('Read gusts');
    await input.evaluate((node) => node.setSelectionRange(2, 5));
    await page.evaluate(() => { window.fixtureSignOut(); });
    await page.getByRole('button', { name: 'Keep editing', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Keep editing', exact: true }).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.matches('.st-inline-field input'));
    assert.deepEqual(await input.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), ['Read gusts', 2, 5, true]);
    assert.equal(await page.evaluate(() => window.signOuts ?? 0), 0);
    await page.evaluate(() => { window.fixtureSignOut(); window.fixtureSignOut(); });
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.waitForFunction(() => window.signOuts === 1);
    await page.getByRole('button', { name: 'Edit prerequisites', exact: true }).click();
    await page.evaluate(() => window.session.dispatch({ kind: 'BulkDelete', nodeIds: ['course'] }));
    await page.getByText('Selection updated', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.draftStore.getSnapshot().draft.draftValue), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('indexed Back and Forward preserve the first destination and a kept caret', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Name', exact: true });
    await input.fill('Kept through Back');
    await input.evaluate((node) => node.setSelectionRange(3, 7));
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.matches('.st-inline-field input'));
    assert.deepEqual(await input.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd]), ['Kept through Back', 3, 7]);
    assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail?step=wind');
    await page.evaluate(() => history.back());
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('article').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => location.hash), '#/app/t_sail');
    await page.evaluate(() => history.forward());
    await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
    assert.equal(await page.locator('.st-inline-field').count(), 0);
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot()), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('field switching admits once, blank names refuse, retry stays sparse, and clean Cancel returns focus', async () => {
  const { page, errors } = await openHost({ width: 744, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('   ');
    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await page.getByText('Give this step a name.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Description', exact: true });
    await input.fill('Sparse retry');
    await page.evaluate(() => {
      const dispatch = window.session.dispatch.bind(window.session);
      window.editWrites = [];
      window.session.dispatch = (gesture) => {
        window.editWrites.push(gesture);
        if (window.editWrites.length === 1) throw new Error('Private failure message');
        return dispatch(gesture);
      };
    });
    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await page.getByText('Couldn’t save this change. Your draft is kept. Try again.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
    await page.getByRole('button', { name: 'Edit description', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.editWrites), Array(2).fill({ kind: 'EditNode', id: 'wind', description: 'Sparse retry' }));
    assert.deepEqual(await page.evaluate(() => window.issues.map(({ operation }) => operation)), ['roadmap-board-edit']);
    assert.equal(await page.evaluate(() => JSON.stringify([window.events, window.issues]).includes('Private failure message')), false);
    await page.getByRole('button', { name: 'Edit name', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit name');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const width of [320, 390, 744, 1024, 1440]) {
  hostTest(`dark ${width}px: input, caret and scroll survive Coach and resize with visible actions`, async () => {
    const { page, errors } = await openHost({ width, height: 700, shell: true });
    try {
      await page.evaluate(() => { window.fixtureTheme('dark'); window.scene.activate('wind'); });
      await page.getByRole('button', { name: 'Edit description', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Description', exact: true });
      await input.fill('Description retained while the document changes shape.\n'.repeat(8));
      await input.evaluate((node) => { node.setSelectionRange(8, 16); node.scrollTop = 48; });
      const before = await input.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd, node.scrollTop]);
      if (width >= 744) {
        const coach = page.getByRole('button', { name: /^(Expand|Collapse) Coach$/ });
        await coach.click();
        await coach.click();
      }
      await page.setViewportSize({ width: width === 320 ? 390 : 320, height: 700 });
      await page.setViewportSize({ width, height: 700 });
      assert.deepEqual(await input.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd, node.scrollTop]), before);
      const controls = page.getByRole('button', { name: /^(Save|Cancel)$/ }).filter({ visible: true });
      assert.deepEqual(await controls.evaluateAll((nodes) => nodes.map((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.width >= 44 && bounds.height >= 44 && bounds.bottom <= innerHeight;
      })), [true, true]);
      if (process.env.WM_INLINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/inline-dark-${width}.png` });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const action of ['Add step', 'Connect']) {
  hostTest(`tablet ${action} waits for the dirty draft decision before changing the Graph`, async () => {
    const { page, errors } = await openHost({ width: 744, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep before tablet action');
      const before = await page.evaluate(() => window.session.lattice.toTreeData().nodes.length);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.length), before);
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Keep before tablet action');
      assert.equal(await page.getByRole('group', { name: 'Choose a step to connect', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('article').waitFor({ state: 'detached' });
      if (action === 'Add step') assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.length), before + 1);
      else await page.getByRole('group', { name: 'Choose a step to connect', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}


for (const field of ['kind', 'prerequisites']) {
  hostTest(`Keep editing restores the current choice in ${field}`, async () => {
    const { page, errors } = await openHost({ width: 744, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
      await page.getByRole('button', { name: `Edit ${field}`, exact: true }).click();
      const choice = field === 'kind' ? page.getByRole('radio', { name: 'Sky', exact: true }) : page.getByRole('checkbox', { name: /Choose a course/ });
      await choice.click();
      const before = await page.evaluate(() => window.draftStore.getSnapshot().draft.draftValue);
      await page.evaluate(() => { window.fixtureSignOut(); });
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.st-draft-decision'));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await choice.evaluate((node) => document.activeElement === node), true);
      assert.deepEqual(await page.evaluate(() => window.draftStore.getSnapshot().draft.draftValue), before);
      assert.equal(await page.evaluate(() => window.signOuts ?? 0), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('one conflict event describes each newly displayed peer value, including a synchronous save refusal', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Local content');
    await page.evaluate(() => {
      const save = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save' && node.getClientRects().length);
      window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer one' });
      save.click();
    });
    await page.getByText('Latest: Peer one', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_step_edit' && props.step === 'conflict')), [{ name: 'roadmap_step_edit', props: { step: 'conflict', field: 'description' } }]);
    await page.evaluate(() => {
      const save = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save anyway' && node.getClientRects().length);
      window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer two' });
      save.click();
    });
    await page.getByText('Latest: Peer two', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load latest', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('New local content');
    await page.evaluate(() => window.session.dispatch({ kind: 'EditNode', id: 'wind', description: 'Peer three' }));
    await page.getByText('Latest: Peer three', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name, props }) => name === 'roadmap_step_edit' && props.step === 'conflict')), Array.from({ length: 3 }, () => ({ name: 'roadmap_step_edit', props: { step: 'conflict', field: 'description' } })));
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'New local content');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('phone field actions intersect the keyboard viewport while preserving Shell, refusal and selection', async () => {
  const { page, errors } = await openHost({ width: 390, height: 844, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Description', exact: true });
    await field.fill('Typing with a keyboard');
    await field.evaluate((node) => node.setSelectionRange(3, 8));
    await page.evaluate(() => {
      window.session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Peer name' });
      window.session.inFlight.set('keyboard-refusal', window.session.lattice.toFrame());
      window.session.receiveReject({ frameId: 'keyboard-refusal', code: 'server-error' });
    });
    await page.getByRole('alert').waitFor();
    const before = await page.locator('.st-step-read-shell').boundingBox();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 450 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const geometry = await page.locator('.st-step-document').evaluate((node) => {
      const box = (selector) => node.querySelector(selector).getBoundingClientRect();
      const toolbar = box('.st-step-toolbar'); const refusal = box('[role="alert"]');
      const scroll = box('.st-step-document-scroll'); const actions = box('.st-inline-actions--pinned');
      return { top: toolbar.top, ordered: toolbar.bottom <= refusal.top && refusal.bottom <= scroll.top && scroll.bottom <= actions.top, saveVisible: actions.bottom <= visualViewport.offsetTop + visualViewport.height, scrollable: scroll.height > 0 };
    });
    assert.deepEqual(geometry, { top: before.y, ordered: true, saveVisible: true, scrollable: true });
    assert.equal(await field.evaluate((node) => {
      const field = node.getBoundingClientRect(); const scroll = node.closest('.st-step-document-scroll').getBoundingClientRect();
      return field.top >= scroll.top && field.bottom <= scroll.bottom;
    }), true);
    assert.deepEqual(await field.evaluate((node) => [node.value, node.selectionStart, node.selectionEnd]), ['Typing with a keyboard', 3, 8]);
    if (process.env.WM_INLINE_SCREENSHOTS) await page.screenshot({ path: `${process.env.WM_INLINE_SCREENSHOTS}/fix-keyboard-inline.png` });
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'scale', { configurable: true, get: () => 2 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.deepEqual(await page.locator('.st-step-read-shell').boundingBox(), before);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


hostTest('nested link recovery and private note Escape leave the dirty shared field intact', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true, clipboardRefused: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep this shared field');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
    await page.locator('.st-step-copy-recovery').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.st-step-copy-recovery').count(), 0);
    assert.equal(await page.locator('.st-draft-decision').count(), 0);
    await page.getByRole('button', { name: /My workspace/ }).click();
    await page.getByRole('button', { name: /note/i }).first().click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.st-draft-decision').count(), 0);
    assert.equal(await page.evaluate(() => window.draftStore.getSnapshot().draft.draftValue), 'Keep this shared field');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('an active draft blocks a stale Save while authority is unready and still responds to permission loss', async () => {
  const { page, errors } = await openHost({ width: 390, shell: true });
  try {
    await page.evaluate(() => window.scene.activate('wind'));
    await page.getByRole('button', { name: 'Edit description', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Keep my pending words');
    await page.evaluate(() => {
      window.writeAttempts = [];
      const dispatch = window.session.dispatch.bind(window.session);
      window.session.dispatch = (gesture) => { window.writeAttempts.push(gesture); return dispatch(gesture); };
      window.session.ready = false;
      const save = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save' && node.getClientRects().length);
      save.click();
      window.session.phase = 'syncing';
      window.session.emitStatus();
    });
    const save = page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true });
    assert.equal(await save.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.writeAttempts), []);
    assert.equal(await page.evaluate(() => Boolean(window.draftStore.getSnapshot().unavailable)), false);
    assert.equal(await page.getByRole('textbox', { name: 'Description', exact: true }).inputValue(), 'Keep my pending words');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } })));
    await page.getByText('Editing is unavailable. Copy your draft or discard it.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
    await page.waitForFunction(() => window.copied.length === 1);
    assert.deepEqual(await page.evaluate(() => window.copied), ['Keep my pending words']);
    assert.deepEqual(await page.evaluate(() => window.writeAttempts), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const code of ['no-such-tree', 'sign-in-required']) {
  hostTest(`an anonymous device owner can save a local field after ${code} without acquiring server reach`, async () => {
    const { page, errors } = await openHost({ width: 390, shell: true, auth: 'ghost', deviceTrees: true });
    try {
      await page.evaluate((code) => {
        const ticket = window.draftScope.begin({ kind: 'anonymous' });
        window.draftScope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } }, ticket);
        window.session.registry = window.fixtureRegistry;
        window.session.receiveReject({ code });
        window.deviceWrites = [];
        const dispatch = window.session.dispatch.bind(window.session);
        window.session.dispatch = (gesture) => { window.deviceWrites.push(gesture); return dispatch(gesture); };
        window.scene.activate('wind');
      }, code);
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Name', exact: true });
      await input.waitFor();
      assert.deepEqual(await page.evaluate(() => ({ owner: window.draftScope.read.getSnapshot().owner, reach: window.session.reach,
        claimed: window.fixtureRegistry.get('t_sail').claimed, writes: window.deviceWrites })),
      { owner: { kind: 'anonymous' }, reach: 'reader', claimed: false, writes: [] });
      await input.fill('Read local gusts');
      await page.getByRole('button', { name: 'Save', exact: true }).filter({ visible: true }).click();
      await page.getByRole('article', { name: 'Read local gusts', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(async () => {
        await window.session.persistNow();
        const saved = await window.session.store.load('t_sail');
        return { label: window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').label,
          savedLabel: saved.frame.nodes.find((node) => node.id === 'wind').label, reach: window.session.reach,
          claimed: window.fixtureRegistry.get('t_sail').claimed, slot: window.draftStore.getSnapshot(), writes: window.deviceWrites };
      }), { label: 'Read local gusts', savedLabel: 'Read local gusts', reach: 'reader', claimed: false, slot: null,
        writes: [{ kind: 'EditNode', id: 'wind', label: 'Read local gusts' }] });
      assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_step_edit').map(({ props }) => props)),
        [{ step: 'open', field: 'label' }, { step: 'saved', field: 'label' }]);
      assert.deepEqual(await page.evaluate(() => window.issues), []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const loss of ['claim', 'device owner', 'permission']) {
  hostTest(`an anonymous device draft refuses a stale Save after a same-task ${loss} change`, async () => {
    const { page, errors } = await openHost({ width: 390, shell: true, auth: 'ghost', deviceTrees: true });
    try {
      await page.evaluate(() => {
        const ticket = window.draftScope.begin({ kind: 'anonymous' });
        window.draftScope.reconcile({ device: { meta: {}, activeReplica: { meta: { state: 'anon' } } } }, ticket);
        window.session.receiveReject({ code: 'no-such-tree' });
        window.scene.activate('wind');
      });
      await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep this refused local name');
      await page.evaluate((loss) => {
        window.deviceWrites = [];
        const dispatch = window.session.dispatch.bind(window.session);
        window.session.dispatch = (gesture) => { window.deviceWrites.push(gesture); return dispatch(gesture); };
        if (loss === 'claim') window.fixtureRegistry.attribute(['t_sail'], 'u_fixture');
        if (loss === 'device owner') window.fixtureRegistry.record('t_sail', 'Learn to sail', 'u_other');
        if (loss === 'permission') window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } }));
        const save = [...document.querySelectorAll('button')].find((node) => node.textContent === 'Save' && node.getClientRects().length);
        save.click();
      }, loss);
      await page.getByText('Editing is unavailable. Copy your draft or discard it.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
      assert.deepEqual(await page.evaluate(() => window.deviceWrites), []);
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').label), 'Read the wind');
      await page.getByRole('button', { name: 'Copy draft', exact: true }).click();
      await page.waitForFunction(() => window.copied.length === 1);
      assert.deepEqual(await page.evaluate(() => window.copied), ['Keep this refused local name']);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const kind of ['claimed', 'reader', 'shared']) {
  hostTest(`device index presence does not grant inline editing to a ${kind} roadmap with reader reach`, async () => {
    const { page, errors } = await openHost({ width: 390, shell: true, auth: 'ghost', deviceTrees: true,
      role: kind === 'reader' ? 'reader' : 'owner', ...(kind === 'shared' ? { address: '#/t/' } : {}) });
    try {
      await page.evaluate((kind) => {
        if (kind === 'claimed') {
          window.fixtureRegistry.attribute(['t_sail'], 'u_fixture');
          window.dispatchEvent(new CustomEvent('wm-tree-claimed', { detail: { treeId: 't_sail' } }));
        }
        window.session.receiveReject({ code: 'no-such-tree' });
        window.scene.activate('wind');
      }, kind);
      await page.getByRole('article', { name: 'Read the wind', exact: true }).waitFor();
      if (kind === 'claimed') await page.getByRole('button', { name: 'Edit name', exact: true }).click();
      else assert.equal(await page.getByRole('button', { name: 'Edit name', exact: true }).count(), 0);
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.draftStore.getSnapshot()), null);
      assert.equal(await page.evaluate(() => window.session.lattice.toTreeData().nodes.find((node) => node.id === 'wind').label), 'Read the wind');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
