import test from 'node:test';
import assert from 'node:assert/strict';

import { CommitError } from '../../../src/platform/sync/client/commit.js';
import { failureReason, GymError, GymRefusal, isStoreFailure } from '../../../src/products/gym/errors.js';

test('failureReason — a refusal, a lapsed sign-in, a row that is gone, this device’s store and a silence each get their own sentence', () => {
  const quota = new CommitError('the device store did not commit', 'store', { cause: new DOMException('storage refused', 'QuotaExceededError') });
  assert.equal(failureReason(new GymError(400, 'that share link has no session')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(409, 'that thread is taken', 'ask-thread-taken')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(503, '')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(new GymError(401, 'sign in to open your training log')), 'you’re signed out. Sign in and try again');
  assert.equal(failureReason(new GymError(404, 'no such session')), 'it isn’t in the log any more');
  assert.equal(failureReason(new GymRefusal('stale')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymRefusal('not-writable')), 'you’re signed out. Sign in and try again');
  assert.equal(failureReason(quota), 'this device couldn’t store it');
  assert.equal(failureReason(new CommitError('unknown change nope')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new TypeError('Failed to fetch')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(undefined), 'the log didn’t answer. Try again when you have signal');
});

test('only the engine’s store failure is this device’s', () => {
  assert.deepEqual([
    new CommitError('the device store did not commit', 'store'),
    new CommitError('a signing-out replica does not commit', 'not-writable'),
    new CommitError('unknown change nope'),
    new DOMException('storage refused', 'QuotaExceededError'),
    new GymRefusal('invalid'),
    new TypeError('Failed to fetch'),
  ].map(isStoreFailure), [true, false, false, false, false, false]);
});

test('a refusal carries the engine code, the sentence a screen shows, and the session an overlap crosses', () => {
  const crossed = { id: 'session0001', startedAt: 1, finishedAt: 2 };
  const overlap = new GymRefusal('session-overlap', { sentence: 'these times cross a session already in the log', overlapping: crossed });
  assert.deepEqual({ name: overlap.name, code: overlap.code, sentence: overlap.sentence, message: overlap.message, overlapping: overlap.overlapping },
    { name: 'GymRefusal', code: 'session-overlap', sentence: 'these times cross a session already in the log', message: 'these times cross a session already in the log', overlapping: crossed });
  const wordless = new GymRefusal('too-large');
  assert.deepEqual({ sentence: wordless.sentence, overlapping: wordless.overlapping }, { sentence: 'The log wouldn’t take this change as written.', overlapping: null });
});
