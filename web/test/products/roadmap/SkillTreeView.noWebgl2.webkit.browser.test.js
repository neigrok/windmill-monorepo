import assert from 'node:assert/strict';
import { webkit } from 'playwright';
import { hostTest, openHost, startRoadmapHost } from './skillTreeViewHost.js';
import { GRAPH_UNAVAILABLE, LABELS, VIEW_SWITCH } from '../../../src/products/roadmap/copy.js';

startRoadmapHost({ browserTypes: { webkit } });

hostTest('WebKit: unavailable Graph explains itself on hover, keyboard focus and press', async () => {
  const { page, errors } = await openHost({ browserName: 'webkit', width: 1440, noWebgl2: true });
  try {
    const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
    const tooltip = page.locator('.st-graph-unavailable-reason');
    await graph.hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await tooltip.textContent(), GRAPH_UNAVAILABLE);
    await page.mouse.move(1400, 500);
    await tooltip.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: VIEW_SWITCH.board, exact: true }).focus();
    await page.keyboard.press('Alt+Tab');
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await graph.evaluate((button) => document.activeElement === button), true);
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: VIEW_SWITCH.board, exact: true }).focus();
    await graph.click({ force: true });
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'board');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_unavailable')),
      [{ name: 'roadmap_graph_unavailable', props: { band: 'desktop' } }]);
    const find = page.getByRole('searchbox', { name: LABELS.findStep, exact: true });
    await page.mouse.move(1400, 500);
    await find.fill('wind');
    await graph.hover();
    await tooltip.waitFor({ state: 'visible' });
    assert.equal(await find.evaluate((input) => document.activeElement === input), true);
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
    assert.deepEqual(await find.evaluate((input) => ({ value: input.value, focused: document.activeElement === input })),
      { value: '', focused: true });
    assert.deepEqual(await page.evaluate(() => window.issues), []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

hostTest('WebKit: a phone tap shows the unavailable reason in the actionless toast', async () => {
  const { page, errors } = await openHost({ browserName: 'webkit', width: 390, noWebgl2: true, touch: true });
  try {
    const graph = page.getByRole('button', { name: VIEW_SWITCH.graph, exact: true });
    assert.equal(await graph.evaluate((button) => document.getElementById(button.getAttribute('aria-describedby')).hidden), true);
    const view = page.getByRole('group', { name: VIEW_SWITCH.group, exact: true });
    assert.equal((await view.ariaSnapshot()).includes(GRAPH_UNAVAILABLE), false);
    await graph.tap({ force: true });
    await page.locator('.st-board-toast-message').filter({ hasText: GRAPH_UNAVAILABLE }).waitFor();
    assert.equal(await page.locator('.st-board-toast button').count(), 0);
    assert.equal(await graph.evaluate((button) => document.getElementById(button.getAttribute('aria-describedby')).textContent), GRAPH_UNAVAILABLE);
    assert.equal(await page.locator('.st-roadmap-identity').getAttribute('data-view'), 'board');
    assert.deepEqual(await page.evaluate(() => window.events.filter(({ name }) => name === 'roadmap_graph_unavailable')),
      [{ name: 'roadmap_graph_unavailable', props: { band: 'phone' } }]);
    assert.deepEqual(await page.evaluate(() => ({ issues: window.issues, graphSeen: window.graphIdentitySeen })), { issues: [], graphSeen: false });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
