import test from 'node:test';
import assert from 'node:assert/strict';

import { isOwnershipRefusal, isSessionRefusal } from '../../../../src/products/roadmap/sync/refusals.js';

// The codes are the wire contract (backend/products/roadmap/adapters/ws/Collab.cpp mints them,
// platform/domain/Access.h owns the ownership pair); the sentences beside them are prose the
// client never reads, so a reworded reason changes nothing here.
test('the editor demotes on exactly the two ownership codes, whatever the sentence says', () => {
  assert.equal(isOwnershipRefusal({ code: 'not-yours', reason: 'this tree belongs to another account' }), true);
  assert.equal(isOwnershipRefusal({ code: 'nobodys-tree', reason: 'reworded tomorrow' }), true);
  assert.equal(isSessionRefusal({ code: 'not-yours' }), false);
  assert.equal(isSessionRefusal({ code: 'nobodys-tree' }), false);
});

test('a session refusal is a suspicion, never an ownership verdict', () => {
  assert.equal(isSessionRefusal({ code: 'sign-in-required', reason: 'sign in to edit' }), true);
  assert.equal(isSessionRefusal({ code: 'sign-in-required', reason: 'sign in to track progress' }), true);
  assert.equal(isOwnershipRefusal({ code: 'sign-in-required' }), false);
});

test('a code neither set knows is neither — the caller warns instead of guessing', () => {
  assert.equal(isOwnershipRefusal({ code: 'no-such-tree' }), false);
  assert.equal(isSessionRefusal({ code: 'no-such-tree' }), false);
  assert.equal(isOwnershipRefusal({ code: 'some-new-code' }), false);
  assert.equal(isSessionRefusal({ code: 'some-new-code' }), false);
});

test('a frame with no code is neither, and the sentence alone earns nothing', () => {
  assert.equal(isOwnershipRefusal({ reason: 'this tree belongs to another account' }), false);
  assert.equal(isSessionRefusal({ reason: 'sign in to edit' }), false);
  assert.equal(isOwnershipRefusal(undefined), false);
  assert.equal(isSessionRefusal(undefined), false);
});
