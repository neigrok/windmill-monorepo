// The shelf's picture of a quest has one job beyond looking right: it must be the same shape the canvas
// will draw when the quest is planted. So this drives the real component and compares every drawn circle
// against the engine the page's own URL names. The component and this file share one layout module, so
// awaiting the engine here awaits the very import the component is waiting on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, settle } from '../../gym/harness.mjs';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { loadLayoutEngine } from '../../../../src/products/roadmap/layout/index.js';



// Every disc the thumbnail drew, by the node it stands for. The halo carries no key, so it stays out.
function discsOf(tree) {
  return elementsOf(tree)
    .filter((element) => element.type === 'circle' && element.key !== null)
    .map((element) => [element.key, element.props.cx, element.props.cy]);
}

async function seatsUnder(layoutName, quest) {
  const positions = (await loadLayoutEngine(layoutName)).layout(new SkillTree(quest));
  return quest.nodes.map((node) => [node.id, positions.get(node.id).x, positions.get(node.id).y]);
}

test("a quest thumbnail draws the seats the page's own engine gives it — bubble by default, radial when the URL says so", async (t) => {
  const QUEST = {
    id: 'sail',
    title: 'Learn to sail',
    kinds: [{ id: 'make', hue: 'terracotta', label: 'Make', description: 'The doing' }],
    nodes: [
      { id: 'knots', label: 'Knots and lines', color: 'terracotta', prerequisites: [], description: 'Tie them.' },
      { id: 'rig', label: 'Rig the mast', color: 'terracotta', prerequisites: ['knots'], description: 'Raise it.' },
      { id: 'trim', label: 'Sail trim', color: 'terracotta', prerequisites: ['rig'], description: 'Shape it.' },
      { id: 'dock', label: 'Docking', color: 'terracotta', prerequisites: ['knots'], description: 'Land it.' },
    ],
  };
  const page = { location: { search: '', hash: '#/app/t_1' } };
  globalThis.window = page;
  t.after(() => { delete globalThis.window; });

  const { QuestThumb } = await loadScreen('products/roadmap/quests/QuestThumb.jsx');

  const bubble = renderHook(t, () => QuestThumb({ quest: QUEST }));
  assert.equal(bubble.tree, null, 'the shelf draws nothing until the engine arrives');
  const bubbleSeats = await seatsUnder('bubble', QUEST);
  await settle();
  assert.deepEqual(discsOf(bubble.tree), bubbleSeats);

  page.location.search = '?layout=radial';
  const radial = renderHook(t, () => QuestThumb({ quest: QUEST }));
  const radialSeats = await seatsUnder('radial', QUEST);
  await settle();
  assert.deepEqual(discsOf(radial.tree), radialSeats);
  assert.notDeepEqual(discsOf(radial.tree), bubbleSeats, 'the two engines really do draw different pictures');
});

test('a quest the tree entity refuses draws nothing rather than crashing the shelf', async (t) => {
  const QUEST = {
    id: 'sail',
    title: 'Learn to sail',
    kinds: [{ id: 'make', hue: 'terracotta', label: 'Make', description: 'The doing' }],
    nodes: [
      { id: 'knots', label: 'Knots and lines', color: 'terracotta', prerequisites: [], description: 'Tie them.' },
      { id: 'rig', label: 'Rig the mast', color: 'terracotta', prerequisites: ['knots'], description: 'Raise it.' },
      { id: 'trim', label: 'Sail trim', color: 'terracotta', prerequisites: ['rig'], description: 'Shape it.' },
      { id: 'dock', label: 'Docking', color: 'terracotta', prerequisites: ['knots'], description: 'Land it.' },
    ],
  };
  globalThis.window = { location: { search: '', hash: '' } };
  t.after(() => { delete globalThis.window; });

  const { QuestThumb } = await loadScreen('products/roadmap/quests/QuestThumb.jsx');
  const cycle = {
    ...QUEST,
    id: 'cycle',
    nodes: [
      { id: 'a', label: 'A', color: 'terracotta', prerequisites: ['b'], description: 'a' },
      { id: 'b', label: 'B', color: 'terracotta', prerequisites: ['a'], description: 'b' },
    ],
  };

  const thumb = renderHook(t, () => QuestThumb({ quest: cycle }));
  await loadLayoutEngine('bubble');
  await settle();
  assert.equal(thumb.tree, null);
});


test('an empty quest has no thumbnail; a root behind its child still owns the crown and halo', async (t) => {
  globalThis.window = { location: { search: '', hash: '' } };
  t.after(() => { delete globalThis.window; });
  const { QuestThumb } = await loadScreen('products/roadmap/quests/QuestThumb.jsx');
  const quest = {
    id: 'root-order', title: 'Root order', nodes: [
      { id: 'child', label: 'Child', color: 'sky', prerequisites: ['root'] },
      { id: 'root', label: 'Root', color: 'gold', prerequisites: [] },
    ],
  };
  const empty = renderHook(t, () => QuestThumb({ quest: { ...quest, nodes: [] } }));
  const thumb = renderHook(t, () => QuestThumb({ quest }));
  await loadLayoutEngine('bubble');
  await settle();
  assert.equal(empty.tree, null);
  const circles = elementsOf(thumb.tree).filter((element) => element.type === 'circle');
  const halo = circles.find((element) => element.props.className === 'quest-thumb-halo');
  const root = circles.find((element) => element.key === 'root');
  const child = circles.find((element) => element.key === 'child');
  assert.deepEqual([halo.props.cx, halo.props.cy], [root.props.cx, root.props.cy]);
  assert.ok(root.props.r > child.props.r);
});
