import assert from 'node:assert/strict';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';

startRoadmapHost();

const events = (page, name) => page.evaluate((wanted) => window.events.filter((event) => event.name === wanted).map((event) => event.props), name);

hostTest('Chromium: every write the Graph makes without a form names what it changed', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => {
      const { onSetKind, onConnectNodes, onDeleteEdge, onReconnectEdge, onSetNodeOrder } = window.scene.options;
      onSetKind('wind', 'olive');
      onConnectNodes('course', 'dock');
      onDeleteEdge('course', 'dock');
      onReconnectEdge('course', 'wind', 'course', 'dock');
      onSetNodeOrder('wind', 'a1');
    });
    const edit = (changed) => ({ step: 'saved', view: 'graph', name: false, description: false, kind: false, prerequisites: false, order: false, ...changed });
    assert.deepEqual(await events(page, 'roadmap_board_edit'), [
      edit({ kind: true }), edit({ prerequisites: true }), edit({ prerequisites: true }), edit({ prerequisites: true }), edit({ order: true }),
    ]);
    await page.evaluate(() => window.scene.options.onCreateChild('wind'));
    assert.deepEqual(await events(page, 'roadmap_board_create'), [{ step: 'saved', door: 'canvas', view: 'graph' }]);
    await page.evaluate(() => window.scene.options.onDeleteNode('dock'));
    assert.deepEqual(await events(page, 'roadmap_board_delete'), [{ step: 'sent', via: 'direct', view: 'graph' }]);
    await page.locator('.st-toast-undo').click();
    assert.deepEqual(await events(page, 'roadmap_graph_toast'), [{ act: 'edit', step: 'undo' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the Graph dock names its door for complete and reset, and multi-select starts and ends once', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    assert.deepEqual(await events(page, 'roadmap_board_complete'), [{ door: 'dock' }]);
    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    assert.deepEqual(await events(page, 'roadmap_board_step_action'), [{ surface: 'dock', action: 'reset' }]);
    await page.evaluate(() => window.scene.options.onSelectionToggle('dock'));
    await page.locator('.st-roadmap-identity').waitFor();
    await page.waitForFunction(() => window.events.some((event) => event.name === 'roadmap_board_select'));
    await page.evaluate(() => window.scene.options.onNodePick(null));
    await page.waitForFunction(() => window.events.filter((event) => event.name === 'roadmap_board_select').length === 2);
    assert.deepEqual(await events(page, 'roadmap_board_select'), [{ step: 'start', view: 'graph' }, { step: 'end', view: 'graph' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: ⌘K names its door, and an Ask AI question reports its send and its answer without its words', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.getByRole('button', { name: 'Ask AI', exact: true }).waitFor();
    await page.keyboard.press('Meta+k');
    const field = page.locator('.st-tend-overlay input');
    await field.waitFor();
    await field.fill('What am I missing?');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.events.some((event) => event.props?.step === 'answer'));
    assert.deepEqual(await events(page, 'roadmap_verb'), [
      { verb: 'askAI', door: 'key', view: 'graph', band: 'desktop' },
      { verb: 'askAI', step: 'send' },
      { verb: 'askAI', step: 'answer', outcome: 'failed' },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the tablet panel names its door for complete', async () => {
  const { page, errors } = await openHost({ width: 800, surface: 'tree' });
  try {
    await page.evaluate(() => window.scene.select('wind'));
    await page.getByRole('button', { name: 'Mark done', exact: true }).click();
    assert.deepEqual(await events(page, 'roadmap_board_complete'), [{ door: 'panel' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: a phone reader Graph with no step selected names the Fork pill', async () => {
  const { page, errors } = await openHost({ width: 390, height: 844, role: 'reader', surface: 'tree' });
  try {
    await page.locator('.st-graph-chrome button', { hasText: 'Fork' }).click();
    assert.deepEqual(await events(page, 'roadmap_verb'), [{ verb: 'fork', door: 'pill', view: 'graph', band: 'phone' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: the roadmap switcher reports the same steps the phone sheet does', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.locator('.st-roadmap-switcher button[aria-haspopup="menu"]').click();
    await page.getByRole('menuitem', { name: 'Browse trees planted in public' }).click();
    assert.deepEqual(await events(page, 'roadmap_sheet'), [{ step: 'open', door: 'switcher' }, { step: 'browse', door: 'switcher' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: Fork from the read-only notice names its door', async () => {
  const { page, errors } = await openHost({ width: 1440 });
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('wm-edit-forbidden', { detail: { code: 'not-yours' } })));
    await page.getByRole('button', { name: /fork/i }).last().click();
    assert.deepEqual((await events(page, 'roadmap_verb')).filter((props) => props.door === 'notice'), [
      { verb: 'fork', door: 'notice', view: 'graph', band: 'desktop' },
    ]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('Chromium: ⌘Z and ⇧⌘Z say which they were, and a pasted plan names its door', async () => {
  const { page, errors } = await openHost({ width: 1440, surface: 'tree' });
  try {
    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+Shift+z');
    assert.deepEqual(await events(page, 'roadmap_board_undo'), [{ act: 'undoKey' }, { act: 'redoKey' }]);
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '# A plan\n- A step');
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
    });
    assert.deepEqual(await events(page, 'roadmap_board_create'), [{ step: 'open', door: 'paste', view: 'graph' }]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
