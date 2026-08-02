import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isOwnershipRefusal, isSessionRefusal } from '../../../../src/products/roadmap/sync/refusals.js';

// A reject frame carries prose and no code, so these four sentences are one truth stated in two
// languages — C++ mints them, JavaScript decides what the editor does about them, and nothing but
// this file makes them agree. The backend half is read from source rather than restated here: a
// copy would drift in exactly the way the test exists to catch.
const COLLAB = readFileSync(
  new URL('../../../../../backend/products/roadmap/adapters/ws/Collab.cpp', import.meta.url),
  'utf8',
);

// C++ splits a long literal across adjacent string constants; join them back before comparing.
function cppConstant(source, name) {
  const declaration = source.match(new RegExp(`constexpr char ${name}\\[\\] =([\\s\\S]*?);`));
  assert.ok(declaration, `${name} is gone from Collab.cpp — the wire sentence moved or was renamed`);
  return [...declaration[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
}

test('the editor demotes on exactly the refusals the server sends about ownership', () => {
  assert.equal(isOwnershipRefusal(cppConstant(COLLAB, 'kNotYours')), true);
  assert.equal(isOwnershipRefusal(cppConstant(COLLAB, 'kNobodysTree')), true);
});

test('an unowned tree is refused by its own sentence, never as somebody else’s', () => {
  const nobodys = cppConstant(COLLAB, 'kNobodysTree');
  assert.equal(nobodys.includes('no account owns this tree'), true);
  assert.equal(nobodys.includes('belongs to another account'), false);
});

test('a session refusal is a suspicion, never an ownership verdict', () => {
  assert.equal(isSessionRefusal('sign in to edit'), true);
  assert.equal(isSessionRefusal('sign in to track progress'), true);
  assert.equal(isOwnershipRefusal('sign in to edit'), false);
  assert.equal(isOwnershipRefusal('sign in to track progress'), false);
});

test('a sentence neither list knows is neither — the caller warns instead of guessing', () => {
  assert.equal(isOwnershipRefusal('some new refusal nobody taught the client'), false);
  assert.equal(isSessionRefusal('some new refusal nobody taught the client'), false);
  assert.equal(isOwnershipRefusal(undefined), false);
  assert.equal(isSessionRefusal(undefined), false);
});
