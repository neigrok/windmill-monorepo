// The scene stand-in records every call by name, so a completion beat would show up beside the gauge.

import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, renderHook } from '../../../gym/harness.mjs';

test('useWorkspace — checking the last subtask fills the gauge and never completes the step', async (t) => {
  browserWith();
  const { useWorkspace } = await import('../../../../../src/products/roadmap/graph/tree/useWorkspace.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const sceneRef = { current: new Proxy({}, { get: (_, name) => (arcs) => calls.push([name, Object.fromEntries(arcs)]) }) };
  const hook = renderHook(t, () => useWorkspace({ seedRef: { current: { id: 'tree-checked' } }, sceneRef, treeRef: { current: null } }));

  hook.tree.onAddSubtask('rig', 'Raise the mast');
  hook.tree.onAddSubtask('rig', 'Bend on the sails');
  const [mast, sails] = hook.tree.workspaceByNode.rig.subtasks;
  hook.tree.onToggleSubtask('rig', mast.id);
  hook.tree.onToggleSubtask('rig', sails.id);
  t.mock.timers.tick(5000);

  assert.deepEqual(hook.tree.workspaceByNode, {
    rig: {
      subtasks: [
        { id: mast.id, label: 'Raise the mast', done: true },
        { id: sails.id, label: 'Bend on the sails', done: true },
      ],
      note: '',
      links: [],
    },
  });
  assert.deepEqual(calls, [
    ['setArcs', { rig: 0 }],
    ['setArcs', { rig: 0 }],
    ['setArcs', { rig: 0.5 }],
    ['setArcs', { rig: 1 }],
  ]);
});

test('useWorkspace — unchecking a subtask on a full gauge reopens only the gauge, and the checklist persists', async (t) => {
  browserWith();
  const { useWorkspace } = await import('../../../../../src/products/roadmap/graph/tree/useWorkspace.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const sceneRef = { current: new Proxy({}, { get: (_, name) => (arcs) => calls.push([name, Object.fromEntries(arcs)]) }) };
  const seedRef = { current: { id: 'tree-unchecked' } };
  const treeRef = { current: null };
  const hook = renderHook(t, () => useWorkspace({ seedRef, sceneRef, treeRef }));

  hook.tree.onAddSubtask('dock', 'Cast off the bow line');
  const [bow] = hook.tree.workspaceByNode.dock.subtasks;
  hook.tree.onToggleSubtask('dock', bow.id);
  hook.tree.onToggleSubtask('dock', bow.id);
  t.mock.timers.tick(5000);

  assert.deepEqual(calls, [
    ['setArcs', { dock: 0 }],
    ['setArcs', { dock: 1 }],
    ['setArcs', { dock: 0 }],
  ]);

  const reopened = renderHook(t, () => useWorkspace({ seedRef, sceneRef, treeRef }));
  reopened.tree.hydrateWorkspaces('tree-unchecked');
  assert.deepEqual(reopened.tree.workspaceByNode, {
    dock: { subtasks: [{ id: bow.id, label: 'Cast off the bow line', done: false }], note: '', links: [] },
  });
});

test('useWorkspace — a step that opens a tree gauges that tree in place of its subtasks, and draws no arc where nothing can be counted', async (t) => {
  browserWith();
  const { useWorkspace } = await import('../../../../../src/products/roadmap/graph/tree/useWorkspace.js');
  const { Opening } = await import('../../../../../src/products/roadmap/model/Opening.js');
  const calls = [];
  const sceneRef = { current: new Proxy({}, { get: (_, name) => (arcs) => calls.push([name, Object.fromEntries(arcs)]) }) };
  const opened = (done, total) => Opening.fromWire({ treeId: 't_opened', title: 'Opened', state: 'open', done, total, loop: false });
  const treeRef = { current: { nodes: [
    { id: 'plan' },
    { id: 'sail', opening: opened(3, 8) },
    { id: 'book', opening: opened(0, 0) },
    { id: 'bike', opening: Opening.fromWire({ treeId: 't_gone', missing: true }) },
    { id: 'late', opening: Opening.unread('t_late') },
  ] } };
  const hook = renderHook(t, () => useWorkspace({ seedRef: { current: { id: 'tree-opening' } }, sceneRef, treeRef }));

  hook.tree.onAddSubtask('plan', 'Pick three things');
  hook.tree.onAddSubtask('sail', 'Join the club');
  hook.tree.onAddSubtask('bike', 'Order the chain');

  assert.deepEqual(calls.at(-1), ['setArcs', { plan: 0, sail: 3 / 8, book: 0 }]);
});
