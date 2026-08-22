import test from 'node:test';
import assert from 'node:assert/strict';

import { isOwnershipRefusal, isSessionRefusal, isCapacityRefusal, strandsTheBank } from '../../../../src/products/roadmap/sync/refusals.js';

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

// The third kind. A full tree refuses the frame with the writer and the seat both intact, so the
// editor neither demotes nor re-checks the session — but the edits behind that frame are banked
// with nowhere to go, and the person must be told rather than left editing into a void.
test('a capacity refusal is its own kind — neither an ownership verdict nor a session doubt', () => {
  assert.equal(isCapacityRefusal({ code: 'tree-too-large', reason: 'this roadmap is at its limit' }), true);
  assert.equal(isOwnershipRefusal({ code: 'tree-too-large' }), false);
  assert.equal(isSessionRefusal({ code: 'tree-too-large' }), false);
  assert.equal(isCapacityRefusal({ code: 'not-yours' }), false);
  assert.equal(isCapacityRefusal({}), false);
});

// The shape, not the word: whether the bank is stranded is decided by the frame the reject names,
// so a refusal code minted after this build still surfaces instead of dying in a console.warn.
test('any reject naming a frame strands the bank; a reject naming none strands nothing', () => {
  assert.equal(strandsTheBank({ code: 'tree-too-large', frameId: 'f1' }), true);
  assert.equal(strandsTheBank({ code: 'a-code-shipped-after-this-build', frameId: 'f2' }), true);
  assert.equal(strandsTheBank({ code: 'not-yours', frameId: 'f3' }), true);
  assert.equal(strandsTheBank({ code: 'sign-in-required' }), false);
  assert.equal(strandsTheBank(undefined), false);
});
