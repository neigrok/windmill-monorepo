import test from 'node:test';
import assert from 'node:assert/strict';

import { sharedKind } from '../../../../src/skilltree/ui/mobile/bulk.js';

test('sharedKind — an empty selection shares no kind (no ring)', () => {
  assert.equal(sharedKind([]), null);
});

test('sharedKind — a single node shares its own kind', () => {
  assert.equal(sharedKind(['terracotta']), 'terracotta');
});

test('sharedKind — a set all of one kind shares it (the swatch rings)', () => {
  assert.equal(sharedKind(['sage', 'sage', 'sage']), 'sage');
});

test('sharedKind — a mixed-kind set shares nothing (no ring until you pick)', () => {
  assert.equal(sharedKind(['sage', 'terracotta']), null);
  assert.equal(sharedKind(['sage', 'sage', 'gold']), null);
});
