import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { ANONYMOUS_OWNER } from '../../../src/products/roadmap/copy.js';

startRoadmapHost();

const guideEvents = (page) => page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_guide').map(({ props }) => props));
const box = (page, selector) => page.locator(selector).evaluate((element) => {
  const { left, top, right, bottom, width } = element.getBoundingClientRect();
  return { left, top, right, bottom, width };
});

hostTest('Chromium: at 1440px the guide is a card on the Graph\'s canvas, written through the room\'s session; on the Board it sits in the flow over no card, and an open note follows it there', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960, shell: true });
  try {
    const add = page.getByRole('button', { name: 'Add guide', exact: true });
    await add.waitFor();
    assert.equal(await page.locator('.st-roadmap-identity .st-guide-card, .st-roadmap-identity [aria-label^="Guide"]').count(), 0);
    await add.click();
    await page.getByRole('dialog', { name: 'Add guide' }).waitFor();
    await page.keyboard.type('One step a week.\nA step is done on the water.');
    await page.getByRole('button', { name: 'Save' }).click();
    const card = page.getByRole('button', { name: 'Guide: One step a week.' });
    await card.waitFor();
    assert.equal(await page.evaluate(() => window.session.lattice.guide), 'One step a week.\nA step is done on the water.');
    const [row, onGraph] = [await box(page, '.st-roadmap-identity'), await box(page, '.st-guide-card')];
    assert.deepEqual({ left: onGraph.left, under: onGraph.top - row.bottom, width: onGraph.width }, { left: 28, under: 38, width: 414 });

    await card.click();
    const note = page.getByRole('dialog', { name: 'Guide' });
    await note.waitFor();
    const reading = await box(page, '.st-guide-paper');
    assert.deepEqual({ left: reading.left, under: reading.top - row.bottom, width: reading.width }, { left: 24, under: 22, width: 642 });

    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await page.locator('.st-board-card').first().waitFor();
    const onBoard = await box(page, '.st-guide-card');
    assert.equal(await page.locator('.st-guide-card').count(), 1);
    assert.deepEqual(await page.evaluate((guide) => [...document.querySelectorAll('.st-board-card, .st-board-filter-strip, .st-board-sort-button')]
      .filter((element) => {
        const other = element.getBoundingClientRect();
        return other.left < guide.right && other.right > guide.left && other.top < guide.bottom && other.bottom > guide.top;
      }).map((element) => element.className), onBoard), []);
    assert.equal(onBoard.top >= row.bottom, true);
    const overBoard = await box(page, '.st-guide-paper');
    assert.deepEqual([overBoard.left - onBoard.left, overBoard.top - onBoard.top], [-4, -16]);
    assert.deepEqual(await guideEvents(page), [
      { step: 'open', door: 'card', view: 'graph', role: 'owner' },
      { step: 'edit', via: 'add' },
      { step: 'save', outcome: 'saved', length: '1-500' },
      { step: 'open', door: 'card', view: 'graph', role: 'owner' },
    ]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await note.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement.matches('.st-guide-card'));
    await card.click();
    assert.deepEqual((await guideEvents(page)).at(-1), { step: 'open', door: 'card', view: 'board', role: 'owner' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const surface of ['tree', 'board']) {
  hostTest(`Chromium: on a phone ${surface === 'tree' ? 'Graph' : 'Board'} a device tree's Guide row sits flush beneath its device line, under the head`, async () => {
    const { page, errors } = await openHost({ width: 390, height: 844, role: 'ghost', surface });
    try {
      await page.getByRole('button', { name: 'Add guide', exact: true }).waitFor();
      await page.evaluate(() => window.session.setGuide('One step a week.'));
      await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
      const line = await page.getByRole('button', { name: ANONYMOUS_OWNER, exact: true }).evaluate((element) => {
        const { top, bottom } = element.getBoundingClientRect();
        return { top, bottom };
      });
      const [head, row] = [await box(page, '.st-roadmap-identity'), await box(page, '.st-guide-row')];
      assert.deepEqual({ lineUnderHead: line.top - head.bottom, rowUnderLine: row.top - line.bottom, left: row.left, width: row.width },
        { lineUnderHead: 0, rowUnderLine: 0, left: 16, width: 358 });
      if (surface === 'tree') {
        const camera = await box(page, '.st-graph-chrome [aria-label="Camera"]');
        assert.equal(camera.top >= row.bottom, true);
      }
      await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
      await page.getByRole('button', { name: 'Edit guide' }).click();
      assert.equal(await page.locator('.st-guide-audience').textContent(), 'Only on this device until you sign in.');
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

hostTest('Chromium: on a phone a guide the session receives mid-edit is said in the sheet with Load latest, which takes it, and Cancel then leaves without asking', async () => {
  const { page, errors } = await openHost({ width: 390, height: 844 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
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
      { step: 'open', door: 'row', view: 'graph', role: 'owner' },
      { step: 'edit', via: 'pencil' },
      { step: 'loadLatest' },
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
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
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
    assert.deepEqual(await guideEvents(reader.page), [{ step: 'open', door: 'row', view: 'graph', role: 'reader' }]);
    assert.deepEqual(reader.errors, []);
  } finally { await reader.page.close(); }
  for (const width of [390, 1440]) {
    const shared = await openHost({ width, height: 844, role: 'reader' });
    try {
      await shared.page.evaluate(() => window.session.setGuide('One step a week.'));
      await shared.page.waitForFunction(() => window.session.lattice.guide === 'One step a week.');
      assert.equal(await shared.page.locator('.st-guide-row, .st-guide-card').count(), 0);
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
    assert.deepEqual(await guideEvents(page), [{ step: 'open', door: 'card', view: 'board', role: 'owner' }, { step: 'edit', via: 'pencil' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the Graph camera frames the tree to the right of the guide\'s card and of its note read in place, and captions keep clear of both', async () => {
  const { page, errors } = await openHost({ width: 1440, height: 960 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
    const row = await box(page, '.st-roadmap-identity');
    const held = (selector) => page.locator(selector).evaluate((element) => {
      const room = document.querySelector('.st-root').getBoundingClientRect();
      const { left, top, width, height } = element.getBoundingClientRect();
      return { left: left - room.left, top: top - room.top, width, height };
    });
    const card = await held('.st-guide-card');
    await page.waitForFunction(() => window.cameraInsets.left === 466);
    assert.deepEqual(await page.evaluate(() => ({ left: window.cameraInsets.left, guide: window.cameraInsets.blocks.find((block) => block.top !== undefined), last: Object.keys(window.cameraInsets.blocks.at(-1)).sort() })),
      { left: 466, guide: card, last: ['bottom', 'height', 'right', 'width'] });
    assert.equal(card.top, row.bottom + 38);
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    await page.waitForFunction(() => window.cameraInsets.left === 690);
    assert.deepEqual(await page.evaluate(() => window.cameraInsets.blocks.find((block) => block.top !== undefined)), await held('.st-guide-paper'));
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.waitForFunction(() => window.cameraInsets.left === 466);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a refusal on the desktop Graph seats the guide\'s card below it, and the open note leaves its message uncovered', async () => {
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
    await page.waitForFunction((bottom) => document.querySelector('.st-guide-card').getBoundingClientRect().top >= bottom, refusal.bottom);
    assert.equal((await box(page, '.st-guide-card')).top, refusal.bottom + 38);
    await page.getByRole('button', { name: 'Guide: One step a week.' }).click();
    assert.equal((await box(page, '.st-guide-paper')).top, refusal.bottom + 22);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: at 744px the guide\'s card ends clear of an open step panel', async () => {
  const { page, errors } = await openHost({ width: 744, height: 1024 });
  try {
    await page.evaluate(() => window.session.setGuide('One step a week.'));
    await page.getByRole('button', { name: 'Guide: One step a week.' }).waitFor();
    assert.equal((await box(page, '.st-guide-card')).width, 414);
    await page.evaluate(() => window.scene.select('wind'));
    await page.locator('.st-detail-panel--open').waitFor();
    await page.waitForFunction(() => document.querySelector('.st-guide-card').getBoundingClientRect().width < 414);
    const [card, panel] = [await box(page, '.st-guide-card'), await box(page, '.st-detail-panel--open')];
    assert.deepEqual({ left: card.left, clear: card.right <= panel.left, width: card.width }, { left: 28, clear: true, width: 744 - 28 - 368 });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
