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

test('NavigateTool — a tap selects the picked step; nothing else runs', () => {
  const { ctx, log } = context({ picked: 'n1', crowded: true, edge: { from: 'a', to: 'b' } });
  assert.equal(tap(new NavigateTool(ctx)), undefined);
  assert.deepEqual(log, [['select', 'n1']]);
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
  assert.deepEqual(viewer.log, [['select', 'n1']]);
});
