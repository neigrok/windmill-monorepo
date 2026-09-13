import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportInsets, frontierTarget } from '../../../../src/products/roadmap/ui/viewport.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { UnlockRules } from '../../../../src/products/roadmap/model/UnlockRules.js';

const MINIMAP_BLOCK = { left: 24, bottom: 24, width: 186, height: 146 };

test('insets follow the breakpoint and the chrome that is up', () => {
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop' }), { top: 76, right: 24, bottom: 24, left: 24, blocks: [MINIMAP_BLOCK] });
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', dockOpen: true }), { top: 76, right: 408, bottom: 24, left: 24, blocks: [MINIMAP_BLOCK] });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', laneInset: 64 }), { top: 156, right: 12, bottom: 80, left: 12, blocks: [] });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', dockOpen: true }), { top: 156, right: 368, bottom: 16, left: 12, blocks: [] });
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', laneInset: 64 }), { top: 156, right: 12, bottom: 80, left: 12, blocks: [] });
  // The lifted action lane rides above an open sheet: the band clears whichever reaches higher, never just the sheet.
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', sheetOpen: true, sheetHeight: 300, laneInset: 64 }), { top: 156, right: 12, bottom: 312, left: 12, blocks: [] });
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', sheetOpen: true, sheetHeight: 60, laneInset: 200 }), { top: 156, right: 12, bottom: 216, left: 12, blocks: [] });
});

test('the corner chrome holds is a block, not an inset: the legend joins the minimap once it has a measured box', () => {
  const legend = { width: 220, height: 180 };
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', legendBox: legend }).blocks, [MINIMAP_BLOCK, { left: 24, bottom: 220, width: 220, height: 180 }]);
  // The tablet keeps the legend and retires the minimap; the phone hides both.
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', legendBox: legend }).blocks, [{ left: 24, bottom: 220, width: 220, height: 180 }]);
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', legendBox: legend }).blocks, []);
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', legendBox: { width: 0, height: 0 } }).blocks, [MINIMAP_BLOCK]);
});

function forest() {
  return new SkillTree({ id: 't', title: 'T', nodes: [
    { id: 'big', label: 'Big crown', prerequisites: [] },
    { id: 'b1', label: 'b1', prerequisites: ['big'] },
    { id: 'b2', label: 'b2', prerequisites: ['big'] },
    { id: 'b3', label: 'b3', prerequisites: ['b1'] },
    { id: 'small', label: 'Small crown', prerequisites: [] },
    { id: 's1', label: 's1', prerequisites: ['small'] },
  ] });
}

test('the frontier is the remembered selection, else the top Next-up row, else the latest completion, else the biggest crown', () => {
  const tree = forest();
  const states = (completed) => UnlockRules.derive(tree, { completed: new Set(completed) });

  assert.equal(frontierTarget(tree, states(['big']), { selectedId: 's1' }), 's1');
  assert.equal(frontierTarget(tree, states(['big']), { selectedId: 'gone' }), 'b1', 'a stale selection falls through; b1 unlocks b3, the others nothing');
  assert.equal(frontierTarget(tree, states(['big', 'b1', 'b2', 'b3', 'small', 's1']), { completedAt: { b3: 5, s1: 9, big: 1 } }), 's1', 'all done: the latest completion');
  assert.equal(frontierTarget(tree, states(['big', 'b1', 'b2', 'b3', 'small', 's1']), {}), 'big', 'nothing witnessed: the crown with the most leaves');
  const blocked = new SkillTree({ id: 'b', title: 'B', nodes: [{ id: 'r', label: 'r', prerequisites: [] }, { id: 'c', label: 'c', prerequisites: ['r'] }] });
  assert.equal(frontierTarget(blocked, UnlockRules.derive(blocked, { completed: new Set() }), {}), 'r', 'the available root is the frontier');
  const empty = new SkillTree({ id: 'e', title: 'E', nodes: [] });
  assert.equal(frontierTarget(empty, new Map(), {}), null);
});
