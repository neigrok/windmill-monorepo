// The scene stand-in records every call by name, so a completion beat would show up beside the gauge.

import test from 'node:test';
import assert from 'node:assert/strict';

import { browserWith, renderHook } from '../../../gym/harness.mjs';

test('useWorkspace — checking the last subtask fills the gauge and never completes the step', async (t) => {
  browserWith();
  const { useWorkspace } = await import('../../../../../src/products/roadmap/ui/tree/useWorkspace.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const sceneRef = { current: new Proxy({}, { get: (_, name) => (arcs) => calls.push([name, Object.fromEntries(arcs)]) }) };
  const hook = renderHook(t, () => useWorkspace({ seedRef: { current: { id: 'tree-checked' } }, sceneRef }));

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
  const { useWorkspace } = await import('../../../../../src/products/roadmap/ui/tree/useWorkspace.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const sceneRef = { current: new Proxy({}, { get: (_, name) => (arcs) => calls.push([name, Object.fromEntries(arcs)]) }) };
  const seedRef = { current: { id: 'tree-unchecked' } };
  const hook = renderHook(t, () => useWorkspace({ seedRef, sceneRef }));

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

  const reopened = renderHook(t, () => useWorkspace({ seedRef, sceneRef }));
  reopened.tree.hydrateWorkspaces('tree-unchecked');
  assert.deepEqual(reopened.tree.workspaceByNode, {
    dock: { subtasks: [{ id: bow.id, label: 'Cast off the bow line', done: false }], note: '', links: [] },
  });
});
