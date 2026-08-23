import test from 'node:test';
import assert from 'node:assert/strict';

import { compareStamps, mintStamp, localDay, daysBefore, msUntilNextDay, watchLocalDay } from '../../../src/products/journal/hlc.js';

test('compareStamps — milliseconds, then counter, then actor, in that order', () => {
  assert.equal(compareStamps('1700:0:a', '1699:9:z'), 1);
  assert.equal(compareStamps('1700:0:z', '1700:1:a'), -1);
  assert.equal(compareStamps('1700:3:b', '1700:3:a'), 1);
  assert.equal(compareStamps('1700:3:a', '1700:3:a'), 0);
});

// Everything past the second colon is the actor, exactly as the server parses it.
test('compareStamps — the actor keeps every colon it contains', () => {
  assert.equal(compareStamps('1700:0:d:1', '1700:0:d:0'), 1);
  assert.equal(compareStamps('1700:0:d:0', '1700:0:d:0'), 0);
});

// An unparseable stamp reads as zero and loses every race; '' is what an unstamped held draft carries.
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

// Never zero or negative — that would spin a rescheduling timer.
test('msUntilNextDay — local midnight, and never a zero wait', () => {
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 23, 0, 0)), 60 * 60 * 1000);
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 0, 0, 0)), 24 * 60 * 60 * 1000);
  assert.equal(msUntilNextDay(new Date(2026, 7, 7, 23, 59, 59, 500)), 1000);
});

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
