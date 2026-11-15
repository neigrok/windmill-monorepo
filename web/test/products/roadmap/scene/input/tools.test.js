import test from 'node:test';
import assert from 'node:assert/strict';

import { NavigateTool, ReadOnlyTool } from '../../../../../src/products/roadmap/scene/input/tools.js';

// A scene stand-in that answers the pick with `picked`, reports `crowded` taps, and logs every verb it is asked to do.
function context({ picked = null, crowded = false, edge = null, editTap = null } = {}) {
  const log = [];
  const ctx = {
    camera: { pan() {}, launchInertia() {} },
    pick: () => picked,
    zoomIntoCrowd: (x, y, pointerType) => { if (crowded) log.push(['zoomIntoCrowd', x, y, pointerType]); return crowded; },
    pickEdge: () => edge,
    select: (id) => log.push(['select', id]),
    activate: (id) => log.push(['activate', id]),
    selectEdge: (e) => log.push(['selectEdge', e]),
    hover() {},
    hoverEdge() {},
  };
  if (editTap) ctx.editTap = (x, y, id) => { log.push(['editTap', id]); return true; };
  return { ctx, log };
}

const tap = (tool, pointerType = 'mouse') => {
  tool.onPointerDown({ x: 10, y: 20 }, { pointerType });
  return tool.onPointerUp({ x: 10, y: 20 }, { pointerType });
};

test('NavigateTool — an ordinary tap selects and explicitly activates its picked step', () => {
  const { ctx, log } = context({ picked: 'n1', crowded: true, edge: { from: 'a', to: 'b' } });
  assert.equal(tap(new NavigateTool(ctx)), undefined);
  assert.deepEqual(log, [['select', 'n1'], ['activate', 'n1']]);
});

test('NavigateTool — a tap in a crowd zooms instead of picking an edge or clearing, and says so', () => {
  const { ctx, log } = context({ crowded: true, edge: { from: 'a', to: 'b' } });
  assert.equal(tap(new NavigateTool(ctx), 'touch'), true);
  assert.deepEqual(log, [['zoomIntoCrowd', 10, 20, 'touch']]);
});

test('NavigateTool — an empty tap beside a branch selects the branch; one on bare canvas clears', () => {
  const near = context({ edge: { from: 'a', to: 'b' } });
  assert.equal(tap(new NavigateTool(near.ctx)), undefined);
  assert.deepEqual(near.log, [['selectEdge', { from: 'a', to: 'b' }]]);

  const bare = context();
  tap(new NavigateTool(bare.ctx));
  assert.deepEqual(bare.log, [['select', null]]);
});

test('ReadOnlyTool — the crowd zoom comes before the phone owner\'s mode routing, which then takes the picked step', () => {
  const crowded = context({ crowded: true, editTap: true });
  assert.equal(tap(new ReadOnlyTool(crowded.ctx), 'touch'), true);
  assert.deepEqual(crowded.log, [['zoomIntoCrowd', 10, 20, 'touch']]);

  const routed = context({ picked: 'n1', editTap: true });
  assert.equal(tap(new ReadOnlyTool(routed.ctx), 'touch'), undefined);
  assert.deepEqual(routed.log, [['editTap', 'n1']]);

  const viewer = context({ picked: 'n1' });
  tap(new ReadOnlyTool(viewer.ctx), 'touch');
  assert.deepEqual(viewer.log, [['select', 'n1'], ['activate', 'n1']]);
});

for (const Tool of [NavigateTool, ReadOnlyTool]) {
  test(`${Tool.name}: modifiers and drags never activate a selected node`, () => {
    for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) {
      const { ctx, log } = context({ picked: 'n1' });
      const tool = new Tool(ctx);
      const event = { pointerType: 'mouse', [modifier]: true };
      tool.onPointerDown({ x: 10, y: 20 }, event);
      tool.onPointerUp({ x: 10, y: 20 }, event);
      assert.deepEqual(log, [['select', 'n1']]);
    }
    const { ctx, log } = context({ picked: 'n1' });
    const tool = new Tool(ctx);
    tool.onPointerDown({ x: 10, y: 20 }, { pointerType: 'touch' });
    tool.onPointerDrag({ x: 80, y: 20 });
    tool.onPointerUp({ x: 80, y: 20 }, { pointerType: 'touch' });
    assert.deepEqual(log, []);
  });
}

test('NavigateTool: a completed reorder never activates, while an unlifted press does', () => {
  const { ctx, log } = context({ picked: 'n1' });
  ctx.beginReorder = () => log.push('begin');
  ctx.commitReorder = () => log.push('commit');
  const tool = new NavigateTool(ctx);
  tool.onPointerDown({ x: 10, y: 20 }, {});
  tool.onPointerDrag({ x: 80, y: 20 });
  tool.onPointerUp({ x: 80, y: 20 }, {});
  assert.deepEqual(log, ['begin', 'commit']);
  log.length = 0;
  tap(tool);
  assert.deepEqual(log, [['select', 'n1'], ['activate', 'n1']]);
});
