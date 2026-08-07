// What this device remembers about the log, read from outside the training room. The blob under
// `windmill.gym.live` is a FOREIGN INPUT — an older build's shape, a write a killed tab truncated,
// a hand edit — and the /app home cell draws a sentence off it, so the only field it trusts is the
// one that cannot be repaired: a note that cannot name its session names no session.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LIVE_KEY, openSessionOnThisDevice, QUEUE_KEY } from '../../../src/products/gym/device.js';

const store = (value) => ({ getItem: (key) => (key === LIVE_KEY ? value : null) });

test('the keys are the ones the logger actually writes under', () => {
  assert.equal(LIVE_KEY, 'windmill.gym.live');
  assert.equal(QUEUE_KEY, 'windmill.gym.queue');
});

test('a note naming a session is a session left open here', () => {
  assert.equal(openSessionOnThisDevice(store('{"sessionId":"ses_9f3a1c22","order":["back-squat"],"exIdx":0}')), 'ses_9f3a1c22');
  // Everything past the id is the logger's business: a blob with nothing else left in it still
  // names where the lifter was, and the log is what settles the rest.
  assert.equal(openSessionOnThisDevice(store('{"sessionId":"ses_9f3a1c22"}')), 'ses_9f3a1c22');
});

test('anything that cannot name a session is no session at all', () => {
  assert.equal(openSessionOnThisDevice(store(null)), null);
  assert.equal(openSessionOnThisDevice(store('')), null);
  assert.equal(openSessionOnThisDevice(store('{"order":["back-squat"],"exIdx":0}')), null);
  assert.equal(openSessionOnThisDevice(store('{"sessionId":""}')), null);
  assert.equal(openSessionOnThisDevice(store('{"sessionId":42}')), null);
  assert.equal(openSessionOnThisDevice(store('{"sessionId":null}')), null);
  // A truncated write, and a store that is not JSON at all.
  assert.equal(openSessionOnThisDevice(store('{"sessionId":"ses_9f3a')), null);
  assert.equal(openSessionOnThisDevice(store('not json')), null);
});

// A browser that refuses storage throws on the read rather than answering null, and the home grid
// may not fail to paint over a question it only asked out of interest.
test('a store that refuses to be read is no session either', () => {
  const refusing = { getItem() { throw new Error('storage disabled'); } };
  assert.equal(openSessionOnThisDevice(refusing), null);
});
