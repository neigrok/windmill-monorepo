// The stamp's order. It is the sole convergence key for a page, so the device, the phone and the
// server all have to compute the same winner from the same two strings — this pins the web third of
// that against the shape the other two implement (backend platform/domain/Ids.h's default spaceship
// over physicalMs/counter/actor, and iOS WindmillPlatform/Hlc.swift's `<`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareStamps, mintStamp, localDay, daysBefore, msUntilNextDay, watchLocalDay } from '../../../src/products/journal/hlc.js';

test('compareStamps — milliseconds, then counter, then actor, in that order', () => {
  assert.equal(compareStamps('1700:0:a', '1699:9:z'), 1);
  assert.equal(compareStamps('1700:0:z', '1700:1:a'), -1);
  assert.equal(compareStamps('1700:3:b', '1700:3:a'), 1);
  assert.equal(compareStamps('1700:3:a', '1700:3:a'), 0);
});

// An actor is free-form and may hold colons; everything past the second one is the actor, exactly
// as the server parses it — otherwise two devices could disagree about who won a tie.
test('compareStamps — the actor keeps every colon it contains', () => {
  assert.equal(compareStamps('1700:0:d:1', '1700:0:d:0'), 1);
  assert.equal(compareStamps('1700:0:d:0', '1700:0:d:0'), 0);
});

// A stamp arrives from storage and from the wire. A corrupted one must still be readable — it
// simply loses every race, which is the safe direction to fail in. The empty stamp is the one an
// UNSTAMPED held draft carries, and it must lose to any real page for the same reason.
test('compareStamps — anything unparseable, and the empty stamp, read as zero', () => {
  assert.equal(compareStamps('', '0:0:'), 0);
  assert.equal(compareStamps('nonsense', '1:0:a'), -1);
  assert.equal(compareStamps('1:0:a', ''), 1);
  assert.equal(compareStamps(undefined, ''), 0);
});

test('mintStamp — strictly increasing within one millisecond, and parseable', () => {
  const first = mintStamp();
  const second = mintStamp();
  assert.equal(compareStamps(second, first), 1);
  assert.equal(first.split(':').length >= 3, true);
});

test('localDay and daysBefore — the writer’s own calendar, never UTC', () => {
  assert.equal(localDay(new Date(2026, 7, 7, 23, 59)), '2026-08-07');
  assert.equal(daysBefore('2026-08-07', 7), '2026-07-31');
  assert.equal(daysBefore('2026-01-01', 1), '2025-12-31');
});

// A canvas left open overnight waits on this, so it must be the writer's own midnight — and it may
// never be zero or negative, which would spin a rescheduling timer.
test('msUntilNextDay — local midnight, and never a zero wait', () => {
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 23, 0, 0)), 60 * 60 * 1000);
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 0, 0, 0)), 24 * 60 * 60 * 1000);
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 23, 59, 59, 500)), 1000);
});

// The canvas's clock, driven with fake timers and a fake wake — no DOM, because neither rule is
// about one. A tab left open overnight is turned over by the timer; a laptop that slept through
// midnight is caught by the wake, which is the half a timer cannot do.
function fakeClock() {
  const timers = new Map();
  let next = 1;
  let woken = null;
  const said = [];
  const stop = watchLocalDay((day) => said.push(day), {
    setTimer: (run, delay) => { const id = next; next += 1; timers.set(id, { run, delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    wake: (settle) => { woken = settle; return () => { woken = null; }; },
  });
  return {
    said,
    stop,
    pending: () => [...timers.values()],
    fire: () => { const [{ run }] = timers.values(); timers.clear(); run(); },
    wake: () => woken(),
    bound: () => woken !== null,
  };
}

test('watchLocalDay — the timer turns the canvas over at midnight and keeps waiting', () => {
  const clock = fakeClock();

  assert.deepEqual(clock.said, []);
  assert.equal(clock.pending().length, 1);

  clock.fire();

  assert.deepEqual(clock.said, [localDay()]);
  assert.equal(clock.pending().length, 1, 'the next midnight is already being waited on');
  assert.equal(clock.pending()[0].delay, msUntilNextDay());
  clock.stop();
});

test('watchLocalDay — a wake re-reads the day, because a slept-through timer is no clock', () => {
  const clock = fakeClock();

  clock.wake();

  assert.deepEqual(clock.said, [localDay()]);
  assert.equal(clock.pending().length, 1, 'the stale timer was replaced, never left to fire twice');
  clock.stop();
});

test('watchLocalDay — stopping leaves nothing bound and nothing waiting', () => {
  const clock = fakeClock();

  clock.stop();

  assert.deepEqual(clock.pending(), []);
  assert.equal(clock.bound(), false);
});
