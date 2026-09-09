import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, DEFAULT_LAYOUT, layoutNameFrom, loadLayoutEngine } from '../../../../src/products/roadmap/layout/index.js';
import { LayoutEngine } from '../../../../src/products/roadmap/model/ports.js';
import { RadialLayoutEngine } from '../../../../src/products/roadmap/layout/RadialLayoutEngine.js';
import { loadDogfoodTree } from '../fixtures/dogfoodTree.js';

test('the layout name comes from the query before or after the hash; anything else is the default', () => {
  assert.deepEqual(LAYOUTS, ['radial', 'rings', 'bubble', 'mindmap']);
  assert.equal(DEFAULT_LAYOUT, 'radial');
  assert.equal(layoutNameFrom({ search: '?layout=bubble', hash: '#/app/t_1' }), 'bubble');
  assert.equal(layoutNameFrom({ search: '', hash: '#/app/t_1?layout=mindmap' }), 'mindmap');
  assert.equal(layoutNameFrom({ search: '?layout=rings', hash: '#/app/t_1?layout=bubble' }), 'bubble');
  assert.equal(layoutNameFrom({ search: '?layout=nope', hash: '#/app/t_1' }), 'radial');
  assert.equal(layoutNameFrom({ search: '', hash: '' }), 'radial');
  assert.equal(layoutNameFrom({}), 'radial');
});

test('every named engine loads as a LayoutEngine with a reorder hint and lays the dogfood tree out the same way twice', async () => {
  const hints = {};
  for (const name of LAYOUTS) {
    const engine = await loadLayoutEngine(name);
    assert.ok(engine instanceof LayoutEngine, `${name} extends LayoutEngine`);
    hints[name] = engine.constructor.reorder;
  }
  assert.deepEqual(hints, { radial: 'ring', rings: 'none', bubble: 'parent-arc', mindmap: 'none' });

  assert.ok((await loadLayoutEngine('radial')) instanceof RadialLayoutEngine);
  const { tree } = loadDogfoodTree();
  for (const name of LAYOUTS) {
    const engine = await loadLayoutEngine(name);
    const positions = engine.layout(tree);
    assert.equal(positions.size, tree.nodes.length, `${name} places every node`);
    assert.deepEqual([...positions.entries()], [...engine.layout(tree).entries()], `${name} is deterministic`);
  }
});

test('a name outside LAYOUTS is refused at the door', async () => {
  await assert.rejects(loadLayoutEngine('orgchart'), { message: 'Unknown layout "orgchart"' });
});
