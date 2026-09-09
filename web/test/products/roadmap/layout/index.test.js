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

test('every named engine loads as a LayoutEngine with a reorder hint; the radial one lays the dogfood tree out', async () => {
  const hints = {};
  for (const name of LAYOUTS) {
    const engine = await loadLayoutEngine(name);
    assert.ok(engine instanceof LayoutEngine, `${name} extends LayoutEngine`);
    hints[name] = engine.constructor.reorder;
  }
  assert.deepEqual(hints, { radial: 'ring', rings: 'none', bubble: 'none', mindmap: 'none' });

  const radial = await loadLayoutEngine('radial');
  assert.ok(radial instanceof RadialLayoutEngine);
  const { tree } = loadDogfoodTree();
  const positions = radial.layout(tree);
  assert.equal(positions.size, tree.nodes.length);
  assert.deepEqual([...positions.entries()], [...radial.layout(tree).entries()]);
});

test('an engine that is not built yet says so from layout(), not from loading', async () => {
  const { tree } = loadDogfoodTree();
  for (const name of ['rings', 'bubble', 'mindmap']) {
    const engine = await loadLayoutEngine(name);
    assert.throws(() => engine.layout(tree), { message: `${name} layout is not built yet` });
  }
  await assert.rejects(loadLayoutEngine('orgchart'), { message: 'Unknown layout "orgchart"' });
});
