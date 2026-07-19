import test from 'node:test';
import assert from 'node:assert/strict';

import { bendOf } from '../../../src/skilltree/scene/ConnectorBatch.js';

// An edge's bow belongs to the edge, not to wherever its ends happen to be sitting. It used to be
// hashed from the endpoint coordinates, so dragging a node re-rolled the curve of every edge
// touching it on every pointer event — the edge appeared to shake because it was a different
// curve each frame.
test('an edge bows by the same amount wherever its ends are', () => {
  assert.equal(bendOf('root', 'child'), bendOf('root', 'child'));
});

test('different edges bow differently', () => {
  const bends = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => bendOf('root', id)));
  assert.ok(bends.size >= 6, `only ${bends.size} distinct bows across 8 edges`);
});

test('the bow stays within half a span either way', () => {
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    const bend = bendOf('root', id);
    assert.ok(bend >= -0.5 && bend < 0.5, `${id} bows ${bend}`);
  }
});
