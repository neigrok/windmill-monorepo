// The stamp's order. It is the sole convergence key for a page, so the device, the phone and the
// server all have to compute the same winner from the same two strings — this pins the web third of
// that against the shape the other two implement (backend platform/domain/Ids.h's default spaceship
// over physicalMs/counter/actor, and iOS WindmillPlatform/Hlc.swift's `<`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareStamps, mintStamp, localDay, daysBefore } from '../../../src/products/journal/hlc.js';

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
