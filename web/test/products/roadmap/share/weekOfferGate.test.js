// The week's offer's timing (weekOfferGate.js), driven on fake timers. Pinned: the cap fires an
// idle offer once; a cap that finds a ceremony coming stands aside, and the ceremony's own follow
// then fires the ask 120ms behind it, exactly once; a director that never goes idle cannot strand
// the ask past three deferrals; and drop cancels everything, including an ask already on its way.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WeekOfferGate, WEEK_OFFER_GAP_MS, CEREMONY_TAIL_CAP_MS, CEREMONY_TAIL_MAX_DEFERRALS,
} from '../../../../src/products/roadmap/share/weekOfferGate.js';

test('the cap fires an idle offer once, and a later follow finds nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new WeekOfferGate(() => false);
  let fired = 0;
  gate.arm(() => { fired += 1; });
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS - 1);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  gate.follow();
  t.mock.timers.tick(WEEK_OFFER_GAP_MS);
  assert.equal(fired, 1);
});

test('the ceremony that closes the open fires the ask 120ms behind its toast, once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new WeekOfferGate(() => false);
  let fired = 0;
  gate.arm(() => { fired += 1; });
  t.mock.timers.tick(1000);
  gate.follow();
  t.mock.timers.tick(WEEK_OFFER_GAP_MS - 1);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS); // the cap was cancelled by the fire
  assert.equal(fired, 1);
});

test('a cap that finds a ceremony coming stands aside; the ceremony then fires the ask, once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The defect's ordering: the phone-list arrival speaks at ~+2830ms, after the 2600ms cap.
  let busy = true;
  const gate = new WeekOfferGate(() => busy);
  let fired = 0;
  gate.arm(() => { fired += 1; });
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
  assert.equal(fired, 0);
  t.mock.timers.tick(230);
  busy = false;
  gate.follow();          // the arrival's toast went through the sink
  t.mock.timers.tick(WEEK_OFFER_GAP_MS - 1);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS * 2); // the deferred cap was cancelled by the fire
  assert.equal(fired, 1);
});

test('a ceremony that speaks no toast is caught by the next cap tick', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let busy = true;
  const gate = new WeekOfferGate(() => busy);
  let fired = 0;
  gate.arm(() => { fired += 1; });
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
  assert.equal(fired, 0);
  busy = false;           // the demo's suppressed arrival ended without a word
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS - 1);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});

test('a director that never goes idle cannot strand the ask past the bounded deferrals', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let probes = 0;
  const gate = new WeekOfferGate(() => { probes += 1; return true; });
  let fired = 0;
  gate.arm(() => { fired += 1; });
  for (let deferral = 1; deferral <= CEREMONY_TAIL_MAX_DEFERRALS; deferral++) {
    t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
    assert.equal(fired, 0);
    assert.equal(probes, deferral);
  }
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
  assert.equal(fired, 1);
  assert.equal(probes, CEREMONY_TAIL_MAX_DEFERRALS + 1);
});

test('drop cancels the armed offer, a deferred cap, and an ask already on its way', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  const armed = new WeekOfferGate(() => false);
  armed.arm(() => { fired += 1; });
  armed.drop();
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS * 2);

  const deferred = new WeekOfferGate(() => true);
  deferred.arm(() => { fired += 1; });
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
  deferred.drop();
  for (let i = 0; i <= CEREMONY_TAIL_MAX_DEFERRALS; i++) t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);

  const following = new WeekOfferGate(() => false);
  following.arm(() => { fired += 1; });
  following.follow();
  following.drop();
  t.mock.timers.tick(WEEK_OFFER_GAP_MS);
  assert.equal(fired, 0);
});

test('re-arming replaces the earlier offer rather than firing both', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new WeekOfferGate(() => false);
  const fired = [];
  gate.arm(() => fired.push('first'));
  t.mock.timers.tick(1000);
  gate.arm(() => fired.push('second'));
  t.mock.timers.tick(CEREMONY_TAIL_CAP_MS);
  assert.deepEqual(fired, ['second']);
});
