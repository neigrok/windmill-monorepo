import test from 'node:test';
import assert from 'node:assert/strict';

import { isSendableMessage, MESSAGE_MAX } from '../../../src/skilltree/feedback/FeedbackClient.js';

test('isSendableMessage — a real line after trimming is sendable', () => {
  assert.equal(isSendableMessage('The tree editor is great'), true);
  assert.equal(isSendableMessage('  padded but real  '), true);
  assert.equal(isSendableMessage('x'), true);
});

test('isSendableMessage — empty or whitespace-only is not sendable', () => {
  assert.equal(isSendableMessage(''), false);
  assert.equal(isSendableMessage('   '), false);
  assert.equal(isSendableMessage('\n\t  \n'), false);
  assert.equal(isSendableMessage(null), false);
  assert.equal(isSendableMessage(undefined), false);
});

test('isSendableMessage — the cap is the trimmed length, inclusive', () => {
  assert.equal(isSendableMessage('a'.repeat(MESSAGE_MAX)), true);
  assert.equal(isSendableMessage('a'.repeat(MESSAGE_MAX + 1)), false);
  assert.equal(isSendableMessage(`   ${'a'.repeat(MESSAGE_MAX)}   `), true);
});
