import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapCaption, placeCaptions, captionCandidates, LABEL_POOL_SIZE } from '../../../../src/products/roadmap/scene/captionLayout.js';
import { Camera2D } from '../../../../src/products/roadmap/scene/Camera2D.js';
import { NODE_BODY_DIAMETER, WORKING_ZOOM } from '../../../../src/products/roadmap/model/geometry.js';

test('captions retain authored words in two lines and truncate only the second line', () => {
  const measure = (text) => Array.from(text).length * 8;
  assert.deepEqual(wrapCaption('Build a daily habit', measure), { text: 'Build a daily habit', width: 152, height: 20 });
  assert.deepEqual(wrapCaption('Build a daily habit and reflect on the whole week', measure), {
    text: 'Build a daily habit\nand reflect on the…', width: 152, height: 40,
  });
  assert.deepEqual(wrapCaption('  ', measure), { text: 'Untitled step', width: 104, height: 20 });
});

test('long Unicode labels wrap without splitting a code point', () => {
  const measure = (text) => Array.from(text).length * 8;
  assert.deepEqual(wrapCaption('🚀'.repeat(45), measure), { text: `${'🚀'.repeat(20)}\n${'🚀'.repeat(19)}…`, width: 160, height: 40 });
});

test('selected and related steps win a bounded candidate pool on a 5000-node overview', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  const nodes = Array.from({ length: 5000 }, (_, index) => ({ id: `n${index}`, x: index, y: 0, state: 'complete', emphasis: 0 }));
  nodes[2].state = 'active';
  nodes[3].emphasis = 1;
  const candidates = captionCandidates(nodes, camera, { selectedId: 'n4999', hoveredId: 'n4998', neighbors: new Set(['n4997']) });
  assert.equal(candidates.length, LABEL_POOL_SIZE * 3);
  assert.deepEqual(candidates.slice(0, 5).map(({ id }) => id), ['n4999', 'n4998', 'n4997', 'n2', 'n3']);
});

test('captions avoid every node body and each other, while selected text stays first', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  camera.restore(0, 0, WORKING_ZOOM);
  const nodes = Array.from({ length: 25 }, (_, index) => ({ id: `n${index}`, x: (index % 5 - 2) * 175, y: (Math.floor(index / 5) - 2) * 150, state: 'complete', emphasis: 0 }));
  const metrics = new Map(nodes.map((node) => [node.id, { text: 'A two line\ncaption', width: 130, height: 40 }]));
  const placements = placeCaptions(nodes, camera, metrics, { selectedId: 'n24' });
  assert.equal(placements[0].id, 'n24');
  assert.equal(placements.length, 25);
  for (const rect of placements) {
    for (const node of nodes) {
      const { x, y } = camera.worldToScreen(node.x, node.y);
      const radius = NODE_BODY_DIAMETER * camera.zoom / 2 * (node.id === 'n24' ? 1.14 : 1);
      assert.ok(rect.right <= x - radius || rect.left >= x + radius || rect.bottom <= y - radius || rect.top >= y + radius, `caption ${rect.id} intersects body ${node.id}`);
    }
    for (const other of placements) {
      if (rect.id === other.id) continue;
      assert.ok(rect.right <= other.left || rect.left >= other.right || rect.bottom <= other.top || rect.top >= other.bottom);
    }
  }
});

test('small pans keep caption assignments and line heights stable across zoom', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, x: (index % 4 - 1.5) * 190, y: (Math.floor(index / 4) - 1) * 170, state: 'complete' }));
  const metrics = new Map(nodes.map((node) => [node.id, { text: 'Readable caption', width: 110, height: 20 }]));
  const first = placeCaptions(nodes, camera, metrics);
  camera.pan(3, 5);
  const next = placeCaptions(nodes, camera, metrics, { retained: new Set(first.map(({ id }) => id)) });
  assert.deepEqual(next.map(({ id }) => id).sort(), first.map(({ id }) => id).sort());
  for (const rect of next) {
    const previous = first.find(({ id }) => id === rect.id);
    assert.equal(rect.left, previous.left + 3);
    assert.equal(rect.top, previous.top + 5);
  }
  camera.zoom = 0.2;
  const overview = placeCaptions(nodes, camera, metrics, { selectedId: 'n11' });
  assert.equal(overview[0].id, 'n11');
  assert.ok(overview.every((rect) => rect.bottom - rect.top === 20));
});

test('a selected caption at the canvas edge never detaches into unrelated canvas', () => {
  const camera = new Camera2D();
  camera.resize(800, 600);
  const nodes = [{ id: 'selected', x: -395, y: -295, state: 'active' }];
  const metrics = new Map([['selected', { text: 'Selected step', width: 140, height: 40 }]]);
  const placements = placeCaptions(nodes, camera, metrics, { selectedId: 'selected' });
  assert.deepEqual(placements, []);
});

test('5000 tiny overview dots leave room for readable branch names', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  camera.zoom = 0.01;
  const nodes = Array.from({ length: 5000 }, (_, index) => ({ id: `n${index}`, x: (index % 100 - 50) * 1000, y: (Math.floor(index / 100) - 25) * 1200, state: 'active', emphasis: index % 100 === 0 ? 1 : 0 }));
  const metrics = new Map(nodes.map((node) => [node.id, { text: 'A readable branch', width: 140, height: 20 }]));
  const placements = placeCaptions(nodes, camera, metrics);
  assert.ok(placements.length >= 8 && placements.length <= LABEL_POOL_SIZE);
  assert.ok(nodes.find((node) => node.id === placements[0].id).emphasis > 0);
  assert.ok(placements.every((rect) => Math.abs(rect.bottom - rect.top - 20) < 0.000001));
});

test('nodes hidden behind a panel cannot starve a visible caption out of the candidate pool', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  camera.setInsets({ right: 408, top: 88, left: 24, bottom: 32 });
  const nodes = Array.from({ length: 300 }, (_, index) => ({ id: `hidden${index}`, x: 450 + index % 10 * 3, y: -300 + Math.floor(index / 10) * 15, state: 'available' }));
  nodes.push({ id: 'visible', x: -400, y: 0, state: 'complete' });
  const metrics = new Map(nodes.map((node) => [node.id, { text: node.id, width: 130, height: 20 }]));
  assert.deepEqual(placeCaptions(nodes, camera, metrics).map(({ id }) => id), ['visible']);
});

test('an editing control hides an obstructed caption instead of displacing it', () => {
  const camera = new Camera2D();
  camera.resize(800, 600);
  const nodes = [{ id: 'step', x: 0, y: 0 }];
  const metrics = new Map([['step', { text: 'Selected step', width: 140, height: 40 }]]);
  const obstacle = { left: 388, right: 412, top: 330, bottom: 354 };
  assert.deepEqual(placeCaptions(nodes, camera, metrics, { selectedId: 'step', obstacles: [obstacle] }), []);
});

test('expanded legend and minimap keep captions clear without starving unobscured steps', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  const legend = { left: 24, right: 210, top: 420, bottom: 680 };
  const minimap = { left: 24, right: 216, top: 690, bottom: 876 };
  const nodes = Array.from({ length: 300 }, (_, index) => ({ id: `covered${index}`, x: -650 + index % 10, y: 20 + Math.floor(index / 10) * 4, state: 'available' }));
  nodes.push({ id: 'visible', x: -390, y: 0, state: 'complete' });
  nodes.push({ id: 'selected', x: -490, y: 260, state: 'active' });
  const metrics = new Map(nodes.map((node) => [node.id, { text: node.id, width: 160, height: 40 }]));
  const placements = placeCaptions(nodes, camera, metrics, { selectedId: 'selected', obstacles: [legend, minimap] });
  assert.deepEqual(placements.map(({ id }) => id), ['visible']);
  for (const rect of placements) {
    for (const obstacle of [legend, minimap]) {
      assert.ok(rect.right <= obstacle.left || rect.left >= obstacle.right || rect.bottom <= obstacle.top || rect.top >= obstacle.bottom);
    }
  }
});

test('a lifted phone action lane hides the covered caption until its attached seat is free', () => {
  const camera = new Camera2D();
  camera.resize(390, 774);
  const nodes = [{ id: 'selected', x: 0, y: 0, state: 'active' }];
  const metrics = new Map([['selected', { text: 'Experiments 1894', width: 150, height: 20 }]]);
  const resting = { left: 0, right: 390, top: 688, bottom: 732 };
  const lifted = { ...resting, top: 420, bottom: 464 };
  const [before] = placeCaptions(nodes, camera, metrics, { selectedId: 'selected', obstacles: [resting] });
  const after = placeCaptions(nodes, camera, metrics, { selectedId: 'selected', obstacles: [lifted] });
  assert.equal(before.id, 'selected');
  assert.deepEqual(after, []);
  assert.ok(before.top >= lifted.top && before.bottom <= lifted.bottom);

});


test('overview names only structural anchors, never an arbitrary active leaf', () => {
  const camera = new Camera2D();
  camera.resize(1440, 900);
  camera.zoom = 0.1;
  const nodes = [
    { id: 'root', x: 0, y: 0 },
    { id: 'branch', x: 2000, y: 0 },
    { id: 'active-leaf', x: -2000, y: 0, state: 'active' },
  ];
  const metrics = new Map(nodes.map((node) => [node.id, { text: node.id, width: 130, height: 20 }]));
  const anchors = new Set(['root', 'branch']);
  const captions = placeCaptions(nodes, camera, metrics, { anchors });
  assert.deepEqual(captions.map(({ id }) => id), ['root', 'branch']);
  for (const caption of captions) {
    const node = nodes.find(({ id }) => id === caption.id);
    const point = camera.worldToScreen(node.x, node.y);
    assert.equal((caption.left + caption.right) / 2, point.x);
    assert.equal(caption.top, point.y + NODE_BODY_DIAMETER * camera.zoom / 2 + 8);
    assert.equal(caption.anchor, true);
  }
});
