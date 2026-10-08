import test from 'node:test';
import assert from 'node:assert/strict';

import {
  preferenceRefusal, restLabel,
} from '../../../../src/products/gym/settings/preferences.js';
import { CommitError } from '../../../../../packages/api-contract/sync/reference/client/commit.js';
import { GymRefusal } from '../../../../src/products/gym/errors.js';

test('rest targets are spelled as a clock, and off is a word', () => {
  assert.equal(restLabel(null), 'off');
  assert.equal(restLabel(90), '1:30');
  assert.equal(restLabel(120), '2:00');
  assert.equal(restLabel(180), '3:00');
  assert.equal(restLabel(15), '0:15');
  assert.equal(restLabel(900), '15:00');
});

test('a refusal speaks in the store’s own words, and finishes itself when there are none', () => {
  assert.equal(preferenceRefusal(new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' })), 'Sign in to save to your training log.');
  assert.equal(preferenceRefusal(new CommitError('the device store did not commit', 'store', { cause: new DOMException('storage refused', 'QuotaExceededError') })), 'that setting didn’t save — this device couldn’t store it');
  assert.equal(preferenceRefusal(null), 'that setting didn’t save — the log didn’t answer. Try again in a moment');
});
