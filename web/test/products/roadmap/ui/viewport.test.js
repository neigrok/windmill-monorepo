import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportInsets, frontierTarget, graphToastPlacement } from '../../../../src/products/roadmap/ui/viewport.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

const MINIMAP_BLOCK = { left: 24, bottom: 24, width: 186, height: 146 };

test('insets follow the breakpoint and the chrome that is up', () => {
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop' }), { top: 76, right: 24, bottom: 24, left: 24, blocks: [MINIMAP_BLOCK] });
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', dockOpen: true }), { top: 76, right: 408, bottom: 24, left: 24, blocks: [MINIMAP_BLOCK] });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet' }), { top: 156, right: 12, bottom: 16, left: 12, blocks: [] });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', dockOpen: true }), { top: 156, right: 368, bottom: 16, left: 12, blocks: [] });
  assert.deepEqual(viewportInsets({ breakpoint: 'phone' }), { top: 156, right: 12, bottom: 16, left: 12, blocks: [] });
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

test('the frontier is the remembered selection, else the top Up next card, else the latest completion, else the biggest crown', () => {
  const tree = forest();
  const progress = (completed, completedAt = {}) => ({ completed: new Set(completed), completedAt });

  assert.equal(frontierTarget(tree, progress(['big']), { selectedId: 's1' }), 's1');
  assert.equal(frontierTarget(tree, progress(['big']), { selectedId: 'gone' }), 'b1', 'a stale selection falls through; b1 unlocks b3 and leads Up next');
  assert.equal(frontierTarget(tree, progress(['big', 'b1', 'b2', 'b3', 'small', 's1'], { b3: 5, s1: 9, big: 1 })), 's1', 'all done: the latest completion');
  assert.equal(frontierTarget(tree, progress(['big', 'b1', 'b2', 'b3', 'small', 's1'])), 'big', 'nothing witnessed: the crown with the most leaves');
  const blocked = new SkillTree({ id: 'b', title: 'B', nodes: [{ id: 'r', label: 'r', prerequisites: [] }, { id: 'c', label: 'c', prerequisites: ['r'] }] });
  assert.equal(frontierTarget(blocked, progress([])), 'r', 'the available root is the frontier');
  const empty = new SkillTree({ id: 'e', title: 'E', nodes: [] });
  assert.equal(frontierTarget(empty, progress([])), null);
});

test('the identity row replaces the top inset and the camera block clears the open dock or panel', () => {
  const cameraBlock = { width: 248, height: 50 };
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', rowBottom: 112, cameraBlock }), {
    top: 112, right: 24, bottom: 24, left: 24,
    blocks: [MINIMAP_BLOCK, { right: 24, bottom: 24, width: 248, height: 50 }],
  });
  assert.deepEqual(viewportInsets({ breakpoint: 'desktop', rowBottom: 112, cameraBlock, dockOpen: true }), {
    top: 112, right: 408, bottom: 24, left: 24,
    blocks: [MINIMAP_BLOCK, { right: 408, bottom: 24, width: 248, height: 50 }],
  });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', rowBottom: 104, cameraBlock }), {
    top: 104, right: 12, bottom: 16, left: 12,
    blocks: [{ right: 24, bottom: 24, width: 248, height: 50 }],
  });
  assert.deepEqual(viewportInsets({ breakpoint: 'tablet', rowBottom: 104, cameraBlock, dockOpen: true }), {
    top: 104, right: 368, bottom: 16, left: 12,
    blocks: [{ right: 368, bottom: 24, width: 248, height: 50 }],
  });
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', rowBottom: 104, cameraBlock }), {
    top: 104, right: 12, bottom: 16, left: 12, blocks: [],
  });
});

test('the phone Graph clears the measured selected-step bar with its safe area and gutter', () => {
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', rowBottom: 108, barBottom: 158 }), {
    top: 108, right: 12, bottom: 170, left: 12, blocks: [],
  });
  assert.deepEqual(viewportInsets({ breakpoint: 'phone', rowBottom: 108, barBottom: 0 }), {
    top: 108, right: 12, bottom: 16, left: 12, blocks: [],
  });
});


test('Graph toast keeps intrinsic width in the tablet canvas and clears the camera below the panel', () => {
  assert.deepEqual(graphToastPlacement({
    width: 744, height: 900, toastWidth: 390, toastHeight: 54, leftInset: 12, rightInset: 368,
    obstacles: [
      { left: 128, right: 376, top: 826, bottom: 876 },
      { left: 408, right: 728, top: 156, bottom: 642 },
    ],
  }), { center: 372, bottom: 82 });
});

test('Graph toast clearance handles camera and minimap together regardless of their order', () => {
  const camera = { left: 368, right: 616, top: 926, bottom: 976 };
  const minimap = { left: 24, right: 210, top: 830, bottom: 976 };
  for (const obstacles of [[camera, minimap], [minimap, camera]]) {
    assert.deepEqual(graphToastPlacement({
      width: 1024, height: 1000, toastWidth: 390, toastHeight: 54, leftInset: 24, rightInset: 408, obstacles,
    }), { center: 320, bottom: 178 });
  }
});

test('Graph toast stays at the edge without collisions and clears a panel that reaches its seat', () => {
  const frame = { width: 744, height: 900, toastWidth: 390, toastHeight: 54, leftInset: 12, rightInset: 368 };
  assert.deepEqual(graphToastPlacement({ ...frame, obstacles: [] }), { center: 372, bottom: 24 });
  assert.deepEqual(graphToastPlacement({ ...frame, obstacles: [{ left: 408, right: 728, top: 156, bottom: 876 }] }),
    { center: 372, bottom: 752 });
});


test('Graph toast rechecks earlier obstacles when minimap clearance reaches the legend', () => {
  assert.deepEqual(graphToastPlacement({
    width: 1024, height: 900, toastWidth: 390, toastHeight: 54, leftInset: 24, rightInset: 408,
    obstacles: [
      { left: 24, right: 210, top: 534, bottom: 680 },
      { left: 368, right: 616, top: 826, bottom: 876 },
      { left: 24, right: 210, top: 730, bottom: 876 },
    ],
  }), { center: 320, bottom: 374 });
});
