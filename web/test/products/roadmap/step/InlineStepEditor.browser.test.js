import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from '../skillTreeViewHost.js';

startRoadmapHost();

for (const width of [320, 390, 744, 1024, 1440]) {
  hostTest(`inline fields preserve sparse saves and their focus targets at ${width}px`, async () => {
    const { page, errors } = await openHost({ width, shell: true });
    try {
      await page.evaluate(() => window.scene.activate('wind'));
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
