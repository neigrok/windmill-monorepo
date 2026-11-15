import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ANONYMOUS_OWNER, STEP_DETAIL } from '../../../src/products/roadmap/copy.js';

startRoadmapHost({ browserTypes: { chromium, webkit } });

const guideEvents = (page) => page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_guide').map(({ props }) => props));
const box = (page, selector) => page.locator(selector).evaluate((element) => {
  const { left, top, right, bottom, width } = element.getBoundingClientRect();
  return { left, top, right, bottom, width };
});

hostTest('Chromium: at 1440px the Guide opens as a modal from the Graph and the Board, and writes through the room session', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960, shell: true });
  try {
    const add = page.getByRole('button', { name: 'Add guide', exact: true });
    await add.waitFor();
    assert.equal(await page.locator('.st-roadmap-identity .st-guide-entry').count(), 1);
    await add.click();
    await page.getByRole('dialog', { name: 'Add guide' }).waitFor();
    await page.keyboard.type('One step a week.\nA step is done on the water.');
    await page.getByRole('button', { name: 'Save' }).click();
    const card = page.getByRole('button', { name: 'Guide: One step a week.' });
    await card.waitFor();
    assert.equal(await page.evaluate(() => window.session.lattice.guide), 'One step a week.\nA step is done on the water.');
    const [row, onGraph] = [await box(page, '.st-roadmap-identity'), await box(page, '.st-guide-entry')];
    assert.deepEqual({ inRow: onGraph.top >= row.top && onGraph.bottom <= row.bottom, width: onGraph.width }, { inRow: true, width: 320 });

    await card.click();
    const note = page.getByRole('dialog', { name: 'Guide' });
    await note.waitFor();
    const reading = await box(page, '.st-guide-paper');
    assert.deepEqual({ left: reading.left, top: reading.top, width: reading.width }, { left: 24, top: 24, width: 1392 });
    assert.equal(await page.locator('.st-root').evaluate((root) => Boolean(root.closest('[inert]'))), true);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await note.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card').first().waitFor();
    const onBoard = await box(page, '.st-guide-entry');
    assert.equal(await page.locator('.st-guide-entry').count(), 1);
    assert.deepEqual(await page.evaluate((guide) => [...document.querySelectorAll('.st-board-card, .st-board-filter-strip, .st-board-sort-button')]
      .filter((element) => {
        const other = element.getBoundingClientRect();
        return other.left < guide.right && other.right > guide.left && other.top < guide.bottom && other.bottom > guide.top;
      }).map((element) => element.className), onBoard), []);
    assert.deepEqual(onBoard, onGraph);
    await card.click();
    await note.waitFor();
    const overBoard = await box(page, '.st-guide-paper');
    assert.deepEqual([overBoard.left, overBoard.top, overBoard.width], [24, 24, 1392]);
    assert.deepEqual(await guideEvents(page), [
      { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' },
      { step: 'edit', via: 'add' },
      { step: 'save', outcome: 'saved', length: '1-500' },
      { step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' },
      { step: 'open', door: 'row', view: 'board', role: 'owner', above: 'none' },
    ]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await note.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-guide-entry'));
    await card.click();
    assert.deepEqual((await guideEvents(page)).at(-1), { step: 'open', door: 'row', view: 'board', role: 'owner', above: 'none' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const surface of ['tree', 'board']) {
  hostTest(`Chromium: a phone ${surface === 'tree' ? 'Graph' : 'Board'} opens its device Guide through the Roadmap sheet`, async () => {
    const { page, errors } = await openHost({ width: 390, height: 844, role: 'ghost', surface, shell: true });
    try {
      assert.equal(await page.locator('.st-guide-row, .st-guide-entry').count(), 0);
      await page.evaluate(() => window.session.setGuide('One step a week.'));
      const line = await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).evaluate((element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      });
      const head = await box(page, '.st-roadmap-identity');
      assert.equal(line.top, head.bottom);
      await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
      await page.getByRole('button', { name: 'Guide', exact: true }).click();
      const note = page.getByRole('dialog', { name: 'Guide', exact: true });
      assert.deepEqual(await box(page, '.st-guide-paper'), { left: 0, top: 52, right: 390, bottom: 844, width: 390 });
      if (process.env.GUIDE_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/phone-${surface}-guide.png` });
      await page.getByRole('button', { name: 'Edit guide' }).click();
      assert.equal(await page.locator('.st-guide-audience').textContent(), 'Only on this device until you sign in.');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await note.getByRole('button', { name: 'Close', exact: true }).click();
      await note.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement.matches('.st-guide-sheet-entry'));
      assert.deepEqual(await guideEvents(page), [
        { step: 'open', door: 'sheet', view: surface === 'tree' ? 'graph' : 'board', role: 'owner', above: 'none' },
        { step: 'edit', via: 'pencil' }, { step: 'cancel' },
      ]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: on a phone a guide the session receives mid-edit is said in the sheet with Load latest, which takes it, and Cancel then leaves without asking', async () => {
  const { page, errors } = await openHost({ width: 390, height: 844 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.evaluate(() => window.session.setGuide('Two steps a week.'));
    const notice = page.locator('.st-guide-status');
    await notice.waitFor();
    assert.deepEqual({ said: await notice.textContent(), role: await notice.getAttribute('role'), draft: await page.locator('.st-guide-field').inputValue(), width: (await box(page, '.st-guide-status')).width },
      { said: 'Guide changed elsewhere. Save replaces the newer guide. Load latest replaces your draft.Load latest', role: 'status', draft: 'One step a week. Written', width: 358 });
    await page.getByRole('button', { name: 'Load latest' }).click();
    assert.deepEqual({ draft: await page.locator('.st-guide-field').inputValue(), said: await notice.count() }, { draft: 'Two steps a week.', said: 0 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
    assert.deepEqual({ asked: await page.getByRole('alertdialog').count(), read: await page.locator('.st-guide-prose').textContent(), guide: await page.evaluate(() => window.session.lattice.guide) },
      { asked: 0, read: 'Two steps a week.', guide: 'Two steps a week.' });
    assert.deepEqual(await guideEvents(page), [
      { step: 'open', door: 'sheet', view: 'graph', role: 'owner', above: 'none' },
      { step: 'edit', via: 'pencil' },
      { step: 'loadLatest' },
      { step: 'cancel' },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: while the guide\'s note is being written the room\'s keys wait beneath it: with focus on Cancel, Backspace and Delete delete no selected step, ⌘A selects nothing more, and F and 0 leave the camera', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
    await page.evaluate(() => window.scene.options.onMarqueeSelect(['wind', 'dock'], false));
    await page.locator('.st-selection-bar').waitFor();
    const room = () => page.evaluate(() => ({
      steps: window.session.lattice.toTreeData().nodes.map((node) => node.id).sort(),
      selection: document.querySelector('.st-selection-bar')?.textContent ?? null,
      camera: window.cameraCalls.length,
    }));
    const before = await room();
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
    for (const key of ['Backspace', 'Delete', 'Meta+a', 'f', '0']) await page.keyboard.press(key);
    assert.deepEqual({ room: await room(), draft: await page.locator('.st-guide-field').inputValue(), note: await page.getByRole('dialog', { name: 'Edit guide' }).count() },
      { room: before, draft: 'One step a week. Written', note: 1 });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: in a room whose session cannot take the guide, a save made with the browser offline says so and reports nothing, and Try again once back online saves', async () => {
  const { page } = await openHost({ width: 390, height: 844 });
  page.removeAllListeners('console');
  const complaints = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) complaints.push(message.text());
  });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Learn to sail', exact: true }).click();
    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.evaluate(() => { window.session.setGuide = () => false; });
    const sent = [];
    let offline = true;
    await page.route('**/v1/trees/t_sail', (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      sent.push(JSON.parse(route.request().postData()).guide);
      return offline ? route.abort('internetdisconnected') : route.fallback();
    });
    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'Save' }).click();
    const line = page.getByRole('alert');
    await line.waitFor();
    assert.deepEqual({ online: await page.evaluate(() => navigator.onLine), footer: await page.locator('.st-guide-footer').textContent(), issues: await page.evaluate(() => window.issues) },
      { online: false, footer: 'You’re offline. Try again when you’re back online.CancelTry again', issues: [] });
    offline = false;
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
    assert.deepEqual({ sent, events: (await guideEvents(page)).slice(2), issues: await page.evaluate(() => window.issues) }, {
      sent: ['One step a week. Written', 'One step a week. Written'],
      events: [
        { step: 'save', outcome: 'failed', length: '1-500', reason: 'offline' },
        { step: 'retry', reason: 'offline' },
        { step: 'save', outcome: 'saved', length: '1-500' },
      ],
      issues: [],
    });
    assert.deepEqual(complaints, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a reader on the app route sees the author\'s note on the tree, and the share route shows no guide', async () => {
  const reader = await openHost({ width: 390, height: 844, role: 'reader', appUrl: true });
  try {
    assert.equal(await reader.page.locator('.st-guide-row').count(), 0);
    await reader.page.evaluate(() => window.session.setGuide('One step a week.'));
    await reader.page.getByRole('button', { name: 'Author’s note: One step a week.' }).click();
    await reader.page.getByRole('dialog', { name: 'Author’s note' }).waitFor();
    assert.equal(await reader.page.getByRole('button', { name: 'Edit guide' }).count(), 0);
    assert.deepEqual(await guideEvents(reader.page), [{ step: 'open', door: 'row', view: 'graph', role: 'reader', above: 'none' }]);
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
  for (const width of [390, 1440]) {
    const shared = await openHost({ width, height: 844, role: 'reader' });
    try {
      await shared.page.evaluate(() => window.session.setGuide('One step a week.'));
      await shared.page.waitForFunction(() => window.session.lattice.guide === 'One step a week.');
      assert.equal(await shared.page.locator('.st-guide-row, .st-guide-entry').count(), 0);
      assert.deepEqual(shared.errors, []);
    } finally { await shared.page.close(); }
  }
});

hostTest('Chromium: the note keeps its draft when the window crosses 744px in the room', async () => {
  const { page, errors } = await openHost({ width: 1024, height: 800, surface: 'board' });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.getByRole('button', { name: 'Edit guide' }).click();
    await page.keyboard.type(' Written');
    await page.setViewportSize({ width: 700, height: 800 });
    await page.locator('.st-guide-paper--phone').waitFor();
    assert.equal(await page.locator('.st-guide-field').inputValue(), 'One step a week. Written');
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.locator('.st-guide-paper:not(.st-guide-paper--phone)').waitFor();
    assert.equal(await page.locator('.st-guide-field').inputValue(), 'One step a week. Written');
    assert.deepEqual(await guideEvents(page), [{ step: 'open', door: 'row', view: 'board', role: 'owner', above: 'none' }, { step: 'edit', via: 'pencil' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the Guide leaves the Graph camera full-width beneath the measured identity row', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    const entry = page.getByRole('button', { name: 'Guide: One step a week.' });
    await entry.waitFor();
    await page.waitForFunction(() => window.cameraInsets.top === document.querySelector('.st-roadmap-identity').offsetHeight);
    const before = await page.evaluate(() => window.cameraInsets);
    assert.equal(before.left, 24);
    assert.equal(before.blocks.some((block) => block.top !== undefined), false);
    await entry.click();
    assert.deepEqual(await page.evaluate(() => window.cameraInsets), before);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Guide' }).waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.cameraInsets), before);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a Graph refusal stays below the identity Guide, and the modal covers both', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960, shell: true });
  try {
    await page.evaluate(() => {
      const session = window.session;
      session.setGuide('One step a week.');
      session.dispatch({ kind: 'RenameNode', id: 'wind', label: 'Read gusts' });
      session.inFlight.set('fixture-refused', session.lattice.toFrame());
      session.receiveReject({ frameId: 'fixture-refused', code: 'server-error' });
    });
    await page.getByRole('alert').waitFor();
    const refusal = await box(page, '.st-graph-refusal');
    assert.equal((await box(page, '.st-guide-entry')).bottom <= refusal.top, true);
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    assert.equal((await box(page, '.st-guide-paper')).top, 24);
    assert.equal(await page.locator('.st-graph-refusal').evaluate((element) => Boolean(element.closest('[inert]'))), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: at 744px the step document preserves the hidden Guide identity and restores its entry on Close', async () => {
  const { page, errors } = await openHost({ width: 744, height: 1024 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    const guide = page.getByRole('button', { name: 'Guide: One step a week.' });
    await guide.waitFor();
    const entry = await guide.elementHandle();
    const before = await box(page, '.st-guide-entry');
    assert.equal(before.width, 44);
    await page.evaluate(() => window.scene.activate('wind'));
    const step = page.getByRole('article', { name: 'Read the wind', exact: true });
    await step.waitFor();
    assert.equal(await step.getAttribute('aria-modal'), null);
    assert.deepEqual(await entry.evaluate((node) => ({ mounted: node.isConnected, inIdentity: !!node.closest('.st-roadmap-identity'), inert: !!node.closest('[inert]') })),
      { mounted: true, inIdentity: true, inert: true });
    assert.equal(await entry.isVisible(), false);
    assert.equal(await page.locator('.st-guide-entry').count(), 1);
    await step.getByRole('button', { name: STEP_DETAIL.close, exact: true }).click();
    await step.waitFor({ state: 'detached' });
    await guide.waitFor();
    assert.equal(await entry.evaluate((node) => node === document.querySelector('.st-guide-entry') && !node.closest('[inert]')), true);
    assert.deepEqual(await box(page, '.st-guide-entry'), before);
    await guide.click();
    await page.getByRole('dialog', { name: 'Guide', exact: true }).waitFor();
    assert.deepEqual(await guideEvents(page), [{ step: 'open', door: 'row', view: 'graph', role: 'owner', above: 'none' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the one Guide entry follows the identity breakpoints and stays above Board content in either theme', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960, shell: true, surface: 'board' });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week, on weekend sails with Maya.\nKinds: Learn and Build.'));
    for (const theme of ['light', 'dark']) for (const width of [743, 744, 1023, 1024, 1279, 1280, 1440]) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-theme', value);
        document.querySelectorAll('[data-theme]').forEach((element) => element.setAttribute('data-theme', value));
      }, theme);
      await page.setViewportSize({ width, height: 960 });
      if (width < 744) {
        await page.locator('.st-roadmap-identity--phone').waitFor();
        assert.equal(await page.locator('.st-guide-row, .st-guide-entry').count(), 0);
        continue;
      }
      await page.locator('.st-guide-entry').waitFor();
      assert.equal(await page.locator('.st-guide-row, .st-guide-entry').count(), 1);
      const guide = await box(page, '.st-guide-entry');
      assert.equal(await page.locator('.st-roadmap-identity .st-guide-entry').count(), 1);
      const cap = width < 1024 ? 44 : width < 1280 ? 200 : 320;
      assert.equal(guide.width <= cap, true, `${theme} ${width}: ${guide.width} <= ${cap}`);
      const strip = await box(page, '.st-board-strip');
      assert.equal(guide.bottom <= strip.top, true);
      assert.equal(await page.locator('.st-roadmap-identity').evaluate((row) => row.scrollWidth <= row.clientWidth), true);
      if (process.env.GUIDE_ARTIFACT_DIR && [744, 1024, 1440].includes(width)) {
        await page.screenshot({ path: `${process.env.GUIDE_ARTIFACT_DIR}/board-${width}-${theme}.png` });
      }
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const browserName of ['chromium', 'webkit']) {
  hostTest(`${browserName}: tooltip Escape keeps the Graph selection until a second Escape`, async () => {
    const { page, errors } = await openHost({ browserName, width: 1440, height: 960, shell: true });
    try {
      await page.evaluate(() => {
        window.session.setGuide('One step a week.');
        window.scene.options.onMarqueeSelect(['wind', 'dock'], false);
      });
      const selection = page.locator('.st-selection-bar');
      await selection.waitFor();
      const before = await selection.textContent();
      for (let press = 0; press < 20 && !await page.locator('.st-guide-entry').evaluate((entry) => entry === document.activeElement); press += 1) {
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      }
      await page.getByRole('tooltip').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('tooltip').count(), 0);
      assert.equal(await selection.count(), 1);
      assert.equal(await selection.textContent(), before);
      assert.equal(await page.locator('.st-guide-entry').evaluate((entry) => entry === document.activeElement), true);
      await page.keyboard.press('Escape');
      await selection.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  hostTest(`${browserName}: the Guide tooltip keeps a long first line inside the tablet viewport`, async () => {
    const { page, errors } = await openHost({ browserName, width: 744, height: 960, longTitle: true, shell: true });
    try {
      const text = 'A long first-line guide that remains a valid note and must stay legible when it is displayed as a tooltip. '.repeat(5);
      await page.evaluate((guide) => window.session.setGuide(guide), text);
      for (let press = 0; press < 20 && !await page.locator('.st-guide-entry').evaluate((entry) => entry === document.activeElement); press += 1) {
        await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
      }
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      assert.deepEqual(await tooltip.evaluate((tip) => {
        const bounds = tip.getBoundingClientRect();
        return { text: tip.textContent, inside: bounds.left >= 0 && bounds.right <= innerWidth };
      }), { text: 'Guide', inside: true });
      assert.equal(await page.locator('.st-guide-entry').getAttribute('aria-label'), `Guide: ${text.trim()}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
