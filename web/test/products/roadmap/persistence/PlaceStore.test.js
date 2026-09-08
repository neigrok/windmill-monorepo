import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaceStore } from '../../../../src/products/roadmap/persistence/PlaceStore.js';

test('old-layout places keep the roadmap and selection but discard obsolete coordinates', () => {
  const store = new PlaceStore({ getItem: () => JSON.stringify({ treeId: 'tree', selectedId: 'step', camera: { x: 9000, y: 12000, zoom: 0.6 }, at: 100 }) });
  assert.deepEqual(store.load(), { treeId: 'tree', selectedId: 'step', camera: null, at: 100 });
});

test('structured-row cameras are discarded when organic placement changes the coordinates', () => {
  const place = { treeId: 'tree', selectedId: 'step', camera: { x: 1200, y: 1800, zoom: 1.1 }, cameraLayout: 'structured-radial-v2', at: 100 };
  const store = new PlaceStore({ getItem: () => JSON.stringify(place) });
  assert.deepEqual(store.load(), { ...place, camera: null });
});

test('an organic-layout camera round-trips with its selected step', () => {
  const items = new Map();
  const store = new PlaceStore({ getItem: (key) => items.get(key), setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) });
  const place = { treeId: 'tree', selectedId: 'step', camera: { x: 130, y: -230, zoom: 1.1 } };
  store.save(place);
  const saved = store.load();
  assert.deepEqual(saved, { ...place, cameraLayout: 'organic-radial-v3', at: saved.at });
  assert.ok(Number.isFinite(saved.at));
  store.forget('other');
  assert.deepEqual(store.load(), saved);
  store.forget('tree');
  assert.equal(store.load(), null);
});
