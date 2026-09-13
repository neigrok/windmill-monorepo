// The composer's ghost promises the reader the shape their paste will take, so it has to be laid out by the
// engine the canvas draws with — and it has to keep that promise as the plan changes under the keystrokes.
// The component and this file share one layout module, so awaiting the engine here awaits the very import
// the component is waiting on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, settle } from '../../gym/harness.mjs';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { loadLayoutEngine } from '../../../../src/products/roadmap/layout/index.js';




function discsOf(tree) {
  return elementsOf(tree)
    .filter((element) => element.type === 'circle')
    .map((element) => [element.key, element.props.cx, element.props.cy]);
}

async function seatsUnder(layoutName, nodes) {
  const tree = new SkillTree({ id: 'ghost', title: '', nodes });
  const positions = (await loadLayoutEngine(layoutName)).layout(tree);
  return nodes.map((node) => [node.id, positions.get(node.id).x, positions.get(node.id).y]);
}

test("the ghost draws the plan on the page's own engine, and redraws it when the plan changes", async (t) => {
  const PLAN = [
    { id: 'knots', label: 'Knots and lines', color: 'terracotta', prerequisites: [], status: 'complete' },
    { id: 'rig', label: 'Rig the mast', color: 'terracotta', prerequisites: ['knots'], status: null },
    { id: 'trim', label: 'Sail trim', color: 'sky', prerequisites: ['rig'], status: null },
  ];
  globalThis.window = { location: { search: '', hash: '#/app/t_1' } };
  t.after(() => { delete globalThis.window; });

  const { GhostSkeleton } = await loadScreen('products/roadmap/paste/GhostSkeleton.jsx');
  let plan = PLAN;
  const ghost = renderHook(t, () => GhostSkeleton({ nodes: plan }));
  assert.equal(ghost.tree, null, 'nothing is drawn inside the coalescing window');

  await new Promise((resolve) => { setTimeout(resolve, 120); });
  const planted = await seatsUnder('bubble', PLAN);
  await settle();
  assert.deepEqual(discsOf(ghost.tree), planted);

  plan = [...PLAN, { id: 'dock', label: 'Docking', color: 'gold', prerequisites: ['knots'], status: null }];
  ghost.redraw();
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  const grown = await seatsUnder('bubble', plan);
  await settle();
  assert.deepEqual(discsOf(ghost.tree), grown);
});

test('under ?layout=radial the ghost is radial too — the preview never contradicts the canvas', async (t) => {
  const PLAN = [
    { id: 'knots', label: 'Knots and lines', color: 'terracotta', prerequisites: [], status: 'complete' },
    { id: 'rig', label: 'Rig the mast', color: 'terracotta', prerequisites: ['knots'], status: null },
    { id: 'trim', label: 'Sail trim', color: 'sky', prerequisites: ['rig'], status: null },
  ];
  globalThis.window = { location: { search: '?layout=radial', hash: '#/app/t_1' } };
  t.after(() => { delete globalThis.window; });

  const { GhostSkeleton } = await loadScreen('products/roadmap/paste/GhostSkeleton.jsx');
  const ghost = renderHook(t, () => GhostSkeleton({ nodes: PLAN }));

  await new Promise((resolve) => { setTimeout(resolve, 120); });
  const planted = await seatsUnder('radial', PLAN);
  await settle();
  assert.deepEqual(discsOf(ghost.tree), planted);
});
