// The rest timer, pinned: a target per movement with one global dial, a value computed from the
// instant the set landed, and an overrun that counts up without ever looking like an error.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REST_SECONDS, NEUTRAL_PREFERENCE_SECONDS, restReadout, restTargetFor,
} from '../../../../src/products/gym/logger/rest.js';

const on = (id, extra = {}) => ({ exercise: { id, ...extra } });

test('restTargetFor — three minutes on the main lifts, two by default, one on small work', () => {
  assert.equal(restTargetFor(on('back-squat')), 180);
  assert.equal(restTargetFor(on('bench-press')), 180);
  assert.equal(restTargetFor(on('overhead-press')), 180);
  assert.equal(restTargetFor(on('romanian-deadlift')), 120);
  assert.equal(restTargetFor(on('face-pull')), 60);
  assert.equal(restTargetFor(on('a-movement-of-your-own')), DEFAULT_REST_SECONDS);
  assert.equal(restTargetFor({ exercise: null }), DEFAULT_REST_SECONDS);
  assert.equal(restTargetFor(), DEFAULT_REST_SECONDS);
  assert.equal(NEUTRAL_PREFERENCE_SECONDS, 180);
});

// One dial scales every target proportionally rather than replacing them: a lifter who rests
// short rests short everywhere, and the main lift is still twice the isolation.
test('restTargetFor — the global preference scales the whole table around its neutral', () => {
  assert.equal(restTargetFor(on('back-squat'), 90), 90);
  assert.equal(restTargetFor(on('romanian-deadlift'), 90), 60);
  assert.equal(restTargetFor(on('face-pull'), 90), 30);
  assert.equal(restTargetFor(on('back-squat'), 300), 300);
  assert.equal(restTargetFor(on('face-pull'), 300), 100);
  assert.equal(restTargetFor(on('back-squat'), 180), 180);
});

test('restTargetFor — a movement that carries its own target wins over the table', () => {
  assert.equal(restTargetFor(on('back-squat', { restSeconds: 240 })), 240);
  assert.equal(restTargetFor(on('back-squat', { restSeconds: 240 }), 90), 120);
});

// THE ONE THE PHONE AND THE DESK USED TO DISAGREE ON. A routine's own rest_seconds rides the frozen
// plan snapshot, never the catalog movement — the web read it off the exercise, where it never is,
// so a routine saved with 180 rested three minutes on the phone and two here. Precedence mirrors
// apps/ios/…/WindmillGym/RestTimer.swift: the plan entry, then the movement, then the table.
test('restTargetFor — this session’s plan entry outranks both the movement and the table', () => {
  assert.equal(restTargetFor({ planEntry: { restSeconds: 180 }, exercise: { id: 'face-pull' } }), 180);
  assert.equal(restTargetFor({ planEntry: { restSeconds: 90 }, exercise: { id: 'back-squat' } }), 90);
  assert.equal(restTargetFor({ planEntry: { restSeconds: 240 }, exercise: { id: 'back-squat', restSeconds: 120 } }), 240);
  // An entry that carries no target of its own falls through, rather than reading as zero.
  assert.equal(restTargetFor({ planEntry: { targetSets: 3 }, exercise: { id: 'back-squat' } }), 180);
  // The dial scales a plan target exactly as it scales a table one.
  assert.equal(restTargetFor({ planEntry: { restSeconds: 180 }, exercise: { id: 'face-pull' } }, 90), 90);
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
