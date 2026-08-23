import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanceStamp,
  distanceTrail,
  monthsApart,
  proseDayMonth,
  reachInWords,
  stampCompact,
  stampPlain,
  stampStacked,
} from '../../../../src/products/journal/echoes/echoDates.js';

test('the three stamps — the margin stacks, the run abbreviates, the trail chip spells the year', () => {
  assert.deepEqual(stampStacked('2026-03-14'), { head: '14 MAR', year: '2026' });
  assert.deepEqual(stampStacked('2024-01-01'), { head: '01 JAN', year: '2024' });
  assert.equal(stampCompact('2025-11-02'), '02 NOV 25');
  assert.equal(stampPlain('2026-03-14'), '14 MAR 2026');
  assert.equal(proseDayMonth('2026-03-14'), '14 March');
  assert.equal(proseDayMonth('2026-12-09'), '9 December');
});

test('monthsApart — the design reads 14 March → 4 August as five months, not four', () => {
  assert.equal(monthsApart('2026-03-14', '2026-08-04'), 5);
  assert.equal(monthsApart('2026-03-14', '2026-07-20'), 4);   // most of a fifth, and not yet five
});

test('monthsApart — a sub-calendar-month reach rounds, and is never zero on the far side', () => {
  assert.equal(monthsApart('2026-07-05', '2026-07-20'), 0);   // 15 days, under the midpoint
  assert.equal(monthsApart('2026-07-05', '2026-07-21'), 1);   // 16 days, over it
  assert.equal(monthsApart('2026-07-05', '2026-08-04'), 1);   // 30 days — a month, not zero months
});

test('monthsApart — whole years, and a backwards pair the CHECK makes unrepresentable', () => {
  assert.equal(monthsApart('2025-03-05', '2026-03-05'), 12);
  assert.equal(monthsApart('2024-01-01', '2026-03-01'), 26);
  assert.equal(monthsApart('2026-08-04', '2026-07-05'), 0);
  assert.equal(monthsApart('2026-07-05', '2026-07-05'), 0);
});

test('distanceStamp — nine characters: weeks below half a month, then months, then a lettered year', () => {
  assert.equal(distanceStamp('2026-07-05', '2026-07-12'), '1 WK');
  assert.equal(distanceStamp('2026-07-05', '2026-07-20'), '2 WK');
  assert.equal(distanceStamp('2026-07-05', '2026-08-04'), '1 MO');
  assert.equal(distanceStamp('2026-03-14', '2026-08-04'), '5 MO');
  assert.equal(distanceStamp('2025-01-05', '2026-03-05'), '1 Y 2');
  assert.equal(distanceStamp('2024-03-05', '2026-03-05'), '2 Y');
});

test('distanceTrail — one hop stays in one unit however far it reaches', () => {
  assert.equal(distanceTrail('2026-07-05', '2026-07-20'), '2 WK');
  assert.equal(distanceTrail('2026-03-14', '2026-08-04'), '5 MO');
  assert.equal(distanceTrail('2025-01-05', '2026-03-05'), '14 MO');
  assert.equal(distanceTrail('2024-03-05', '2026-03-05'), '24 MO');
});

test('reachInWords — the sheet says how far it read, and it is never "zero months"', () => {
  assert.equal(reachInWords('2026-07-05', '2026-07-12'), 'one week');
  assert.equal(reachInWords('2026-07-05', '2026-07-20'), 'two weeks');
  assert.equal(reachInWords('2026-07-05', '2026-08-04'), 'one month');
  assert.equal(reachInWords('2026-03-14', '2026-08-04'), 'five months');
  assert.equal(reachInWords('2025-03-05', '2026-03-05'), 'one year');
  assert.equal(reachInWords('2024-03-05', '2026-03-05'), 'two years');
  assert.equal(reachInWords('2023-09-05', '2026-03-05'), 'two and a half years');
});

test('reachInWords — no reach a page can carry reads as nothing', () => {
  for (let days = 7; days <= 400; days += 1) {
    const newer = new Date(Date.UTC(2026, 0, 1) + days * 86400000).toISOString().slice(0, 10);
    const said = reachInWords('2026-01-01', newer);
    assert.ok(!said.startsWith('zero'), `${days} days apart read as "${said}"`);
  }
});
