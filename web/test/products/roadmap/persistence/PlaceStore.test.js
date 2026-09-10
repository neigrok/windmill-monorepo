import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaceStore } from '../../../../src/products/roadmap/persistence/PlaceStore.js';

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: (key) => items.delete(key) };
}

test('a place round-trips under the layout that saved it', () => {
  const store = new PlaceStore(memoryStorage());
  store.save({ treeId: 'tree', layout: 'radial', camera: { x: 130, y: -230, zoom: 1.1 }, selectedId: 'step' });
  const saved = store.load('radial');
  assert.deepEqual(saved, { treeId: 'tree', layout: 'radial', cameraFormat: 'bubble-168-1', camera: { x: 130, y: -230, zoom: 1.1 }, selectedId: 'step', at: saved.at });
  assert.ok(Number.isFinite(saved.at));
});

test('another layout, or a camera saved before the working-zoom format, keeps the tree and selection but no camera', () => {
  const store = new PlaceStore(memoryStorage());
  store.save({ treeId: 'tree', layout: 'radial', camera: { x: 1, y: 2, zoom: 0.6 }, selectedId: 'step' });
  const other = store.load('bubble');
  assert.deepEqual(other, { treeId: 'tree', layout: 'radial', cameraFormat: 'bubble-168-1', camera: null, selectedId: 'step', at: other.at });

  const legacy = new PlaceStore({ getItem: () => JSON.stringify({ treeId: 'tree', selectedId: 'step', camera: { x: 9000, y: 12000, zoom: 0.6 }, at: 100 }) });
  assert.deepEqual(legacy.load('radial'), { treeId: 'tree', selectedId: 'step', camera: null, at: 100 });
});

test('forget drops only the remembered tree; storage faults read as no place', () => {
  const store = new PlaceStore(memoryStorage());
  store.save({ treeId: 'tree', layout: 'radial', camera: { x: 0, y: 0, zoom: 1 } });
  store.forget('other');
  assert.equal(store.load('radial').treeId, 'tree');
  store.forget('tree');
  assert.equal(store.load('radial'), null);

  const broken = new PlaceStore({ getItem: () => { throw new Error('quota'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} });
  assert.equal(broken.load('radial'), null);
  broken.save({ treeId: 'tree', layout: 'radial' });
});

test('the readability lab camera is discarded after the 168 px bubble geometry graduates', () => {
  const place = { treeId: 'tree', layout: 'bubble', cameraFormat: 'working-zoom-1', camera: { x: 9000, y: 12000, zoom: 0.6 }, selectedId: 'step', at: 100 };
  const store = new PlaceStore({ getItem: () => JSON.stringify(place) });
  assert.deepEqual(store.load('bubble'), { ...place, camera: null });
});
