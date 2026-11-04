import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSurface } from '../../../../../src/products/roadmap/graph/tablet/useTabletEditing.js';

test('activeSurface — nothing selected is the empty (closed) panel', () => {
  assert.equal(activeSurface({ multiMode: false, aim: null, removing: null, selectedNode: null }), 'empty');
});

test('activeSurface — a lone selection opens the editor', () => {
  assert.equal(activeSurface({ multiMode: false, aim: null, removing: null, selectedNode: { id: 'n1' } }), 'editor');
});

test('activeSurface — a remove-link bar outranks the editor', () => {
  assert.equal(activeSurface({ multiMode: false, aim: null, removing: { from: 'a', to: 'b' }, selectedNode: { id: 'n1' } }), 'remove');
});

test('activeSurface — aiming outranks removing and the editor', () => {
  assert.equal(activeSurface({ multiMode: false, aim: { sourceId: 'a', direction: 'unlocks' }, removing: { from: 'a', to: 'b' }, selectedNode: { id: 'n1' } }), 'aim');
});

test('activeSurface — multi-select wins over every other surface', () => {
  assert.equal(activeSurface({ multiMode: true, aim: { sourceId: 'a', direction: 'unlocks' }, removing: { from: 'a', to: 'b' }, selectedNode: { id: 'n1' } }), 'bulk');
});
