import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '../../gym/harness.mjs';
import { useGraphStructure } from '../../../../src/products/roadmap/graph/useGraphStructure.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { fallbackLayoutEngine } from '../../../../src/products/roadmap/layout/index.js';

test('scene-less structure installs every create, edit, delete and Undo projection into the Board model', (t) => {
  const root = { id: 'course', label: 'Choose a course', prerequisites: [], color: 'terracotta' };
  const created = { id: 'wind', label: 'Read the wind', prerequisites: ['course'], color: 'sky' };
  const edited = { ...created, label: 'Read gusts' };
  const initial = { id: 't_sail', title: 'Learn to sail', nodes: [root] };
  const room = { projectionRef: { current: initial }, treeRef: { current: null }, sceneRef: { current: null }, sessionRef: { current: null } };
  const legends = [];
  const toasts = [];
  const props = { room, progressActs: { snapshot: { completed: new Set(['course']) } },
    showToast: (...args) => toasts.push(args), syncLegendFromTree: (tree) => legends.push(tree) };
  const view = renderHook(t, () => useGraphStructure(props));
  let structure = view.tree;
  const engine = fallbackLayoutEngine();
  structure.layoutRef.current = { requestedName: 'radial', name: 'radial', engine };
  structure.install(new SkillTree(initial), null, null);

  const projections = [[root, created], [root, edited], [root], [root, edited]];
  for (const nodes of projections) {
    const projection = { ...initial, nodes };
    structure.onTreeChanged(projection);
    structure = view.tree;
    assert.equal(room.projectionRef.current, projection);
    assert.equal(room.treeRef.current, structure.tree);
    assert.deepEqual(structure.tree.nodes, nodes);
    assert.deepEqual(structure.renderModel.nodes.map(({ id, label, color, state }) => ({ id, label, color, state })), nodes.map(({ id, label, color }) => ({
      id, label, color, state: id === 'course' ? 'complete' : 'available',
    })));
    assert.deepEqual(structure.renderModel.edges, nodes.length === 1 ? [] : [{ from: 'course', to: 'wind', kind: 'trunk' }]);
    assert.equal(structure.bounds, null);
    assert.equal(legends.at(-1), projection);
  }
  assert.deepEqual(toasts, []);
  assert.equal(legends.length, 4);
});
