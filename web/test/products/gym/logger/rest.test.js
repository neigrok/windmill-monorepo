// The rest timer, pinned: a target per movement with one global dial, a value computed from the
// instant the set landed, and an overrun that counts up without ever looking like an error.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REST_SECONDS, NEUTRAL_PREFERENCE_SECONDS, restReadout, restTargetFor,
} from '../../../../src/products/gym/logger/rest.js';

test('restTargetFor — three minutes on the main lifts, two by default, one on small work', () => {
  assert.equal(restTargetFor({ id: 'back-squat' }), 180);
  assert.equal(restTargetFor({ id: 'bench-press' }), 180);
  assert.equal(restTargetFor({ id: 'overhead-press' }), 180);
  assert.equal(restTargetFor({ id: 'romanian-deadlift' }), 120);
  assert.equal(restTargetFor({ id: 'face-pull' }), 60);
  assert.equal(restTargetFor({ id: 'a-movement-of-your-own' }), DEFAULT_REST_SECONDS);
  assert.equal(restTargetFor(null), DEFAULT_REST_SECONDS);
  assert.equal(NEUTRAL_PREFERENCE_SECONDS, 180);
});

// One dial scales every target proportionally rather than replacing them: a lifter who rests
// short rests short everywhere, and the main lift is still twice the isolation.
test('restTargetFor — the global preference scales the whole table around its neutral', () => {
  assert.equal(restTargetFor({ id: 'back-squat' }, 90), 90);
  assert.equal(restTargetFor({ id: 'romanian-deadlift' }, 90), 60);
  assert.equal(restTargetFor({ id: 'face-pull' }, 90), 30);
  assert.equal(restTargetFor({ id: 'back-squat' }, 300), 300);
  assert.equal(restTargetFor({ id: 'face-pull' }, 300), 100);
  assert.equal(restTargetFor({ id: 'back-squat' }, 180), 180);
});

test('restTargetFor — a movement that carries its own target wins over the table', () => {
  assert.equal(restTargetFor({ id: 'back-squat', restSeconds: 240 }), 240);
  assert.equal(restTargetFor({ id: 'back-squat', restSeconds: 240 }, 90), 120);
});

test('restReadout — remaining is computed from the instant the set landed, never counted down', () => {
  const startedAt = 1_900_000_000_000;
  assert.deepEqual(restReadout({ targetSeconds: 180, startedAt, now: startedAt }), {
    left: 180, overrun: false, landed: false, label: 'resting · target 3:00', time: '3:00',
  });
  assert.deepEqual(restReadout({ targetSeconds: 180, startedAt, now: startedAt + 49_000 }), {
    left: 131, overrun: false, landed: false, label: 'resting · target 3:00', time: '2:11',
  });
  // A phone locked through the whole rest comes back to the truth, not to where a counter stopped.
  assert.deepEqual(restReadout({ targetSeconds: 180, startedAt, now: startedAt + 187_000 }), {
    left: -7, overrun: true, landed: true, label: 'rest done · target 3:00', time: '+0:07',
  });
  assert.deepEqual(restReadout({ targetSeconds: 180, startedAt, now: startedAt + 264_000 }), {
    left: -84, overrun: true, landed: true, label: 'rest done · target 3:00', time: '+1:24',
  });
  assert.deepEqual(restReadout({ targetSeconds: 180, startedAt, now: startedAt + 180_000 }), {
    left: 0, overrun: false, landed: true, label: 'resting · target 3:00', time: '0:00',
  });
});
