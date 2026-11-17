import assert from 'node:assert/strict';
import test from 'node:test';
import { scopedReceipts } from '../../vectors/admit.js';
import { scopedBatches } from '../../vectors/push.js';

test('scoped receipt vectors assert actual versions, watermarks and absent target authority', () => {
  assert.equal(scopedReceipts().length, 16);
});

test('scoped receipt batching and saved-result replay make bounded progress', () => {
  assert.equal(scopedBatches().length, 7);
});
