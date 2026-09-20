import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LAYOUT, FALLBACK_LAYOUT, LAYOUTS, fallbackLayoutEngine, layoutNameFrom, layoutTree, loadLayoutEngine,
  pageLayoutEngine,
} from '../../../../src/products/roadmap/layout/index.js';
import { LayoutEngine } from '../../../../src/products/roadmap/model/ports.js';
import { RadialLayoutEngine } from '../../../../src/products/roadmap/layout/RadialLayoutEngine.js';
import { BubbleLayoutEngine } from '../../../../src/products/roadmap/layout/BubbleLayoutEngine.js';
import { loadDogfoodTree } from '../fixtures/dogfoodTree.js';

test('the layout name comes from the query before or after the hash; anything else is bubble, the default', () => {
  assert.deepEqual(LAYOUTS, ['radial', 'rings', 'bubble', 'mindmap']);
  assert.equal(DEFAULT_LAYOUT, 'bubble');
  assert.equal(FALLBACK_LAYOUT, 'radial');
  assert.equal(layoutNameFrom({ search: '?layout=radial', hash: '#/app/t_1' }), 'radial');
  assert.equal(layoutNameFrom({ search: '', hash: '#/app/t_1?layout=mindmap' }), 'mindmap');
  assert.equal(layoutNameFrom({ search: '?layout=rings', hash: '#/app/t_1?layout=radial' }), 'radial');
  assert.equal(layoutNameFrom({ search: '?layout=nope', hash: '#/app/t_1' }), 'bubble');
  assert.equal(layoutNameFrom({ search: '', hash: '' }), 'bubble');
  assert.equal(layoutNameFrom({}), 'bubble');
});

test('every named engine loads as a LayoutEngine with a reorder hint and lays the dogfood tree out the same way twice', async () => {
  const hints = {};
  for (const name of LAYOUTS) {
    const engine = await loadLayoutEngine(name);
    assert.ok(engine instanceof LayoutEngine, `${name} extends LayoutEngine`);
    assert.equal(engine.constructor.layoutName, name);
    hints[name] = engine.constructor.reorder;
  }
  assert.deepEqual(hints, { radial: 'ring', rings: 'none', bubble: 'parent-arc', mindmap: 'none' });

  assert.ok((await loadLayoutEngine(DEFAULT_LAYOUT)) instanceof BubbleLayoutEngine);
  assert.ok((await loadLayoutEngine(FALLBACK_LAYOUT)) instanceof RadialLayoutEngine);
  const { tree } = loadDogfoodTree();
  for (const name of LAYOUTS) {
    const engine = await loadLayoutEngine(name);
    const positions = engine.layout(tree);
    assert.equal(positions.size, tree.nodes.length, `${name} places every node`);
    assert.deepEqual([...positions.entries()], [...engine.layout(tree).entries()], `${name} is deterministic`);
  }
});

test('the page draws with the engine its own URL names, and with the default when it names none', async (t) => {
  const page = { location: { search: '', hash: '#/app/t_1' } };
  globalThis.window = page;
  t.after(() => { delete globalThis.window; });

  assert.ok((await pageLayoutEngine()) instanceof BubbleLayoutEngine);
  page.location.hash = '#/app/t_1?layout=radial';
  assert.ok((await pageLayoutEngine()) instanceof RadialLayoutEngine);
  page.location.search = '?layout=mindmap';
  page.location.hash = '#/app/t_1';
  assert.equal((await pageLayoutEngine()).constructor.name, 'MindmapLayoutEngine');
});

test('a name outside LAYOUTS is refused at the door', async () => {
  await assert.rejects(loadLayoutEngine('orgchart'), { message: 'Unknown layout "orgchart"' });
});

test('an engine that throws never blanks the canvas — radial lays the tree out instead, loudly, the default included', () => {
  const { tree } = loadDogfoodTree();
  class BrokenEngine {
    layout() { throw new Error('no picture'); }
  }
  class BubbleLayoutEngineThatThrows extends BubbleLayoutEngine {
    layout() { throw new Error('no picture'); }
  }
  const said = [];
  const spoke = console.error;
  console.error = (...args) => said.push(args[0]);
  try {
    const fallback = layoutTree(new BrokenEngine(), tree);
    assert.equal(fallback.name, 'radial');
    assert.equal(fallback.engine.constructor.reorder, 'ring');
    assert.deepEqual([...fallback.positions], [...fallback.engine.layout(tree)]);
    assert.deepEqual([...layoutTree(new BubbleLayoutEngineThatThrows(), tree).positions.entries()], [...fallbackLayoutEngine().layout(tree).entries()]);
  } finally {
    console.error = spoke;
  }
  assert.deepEqual(said, [
    `[layout] BrokenEngine could not lay out ${tree.allNodes.length} steps — drawing the tree radially instead`,
    `[layout] BubbleLayoutEngineThatThrows could not lay out ${tree.allNodes.length} steps — drawing the tree radially instead`,
  ]);
});
