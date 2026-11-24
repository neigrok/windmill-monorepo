import test from 'node:test';
import assert from 'node:assert/strict';
import { countBucket } from '../../src/telemetry/countBucket.js';

test('event counts are bounded buckets', () => {
  assert.deepEqual([0, 1, 2, 5, 6, 20, 21, 5000].map(countBucket), ['0', '1', '2-5', '2-5', '6-20', '6-20', '21+', '21+']);
});
