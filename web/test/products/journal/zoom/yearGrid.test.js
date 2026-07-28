import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYear } from '../../../../src/products/journal/zoom/yearGrid.js';

test('buildYear — no pages is an empty map', () => {
  assert.deepEqual(buildYear([]), []);
});

test('buildYear — spans first written month to last, filling the gap months whole', () => {
  const months = buildYear([
    { day: '2026-05-09', mood: 4, energy: 2 },
    { day: '2026-07-02', mood: 2, energy: 1 },
  ]);
  assert.deepEqual(months.map((m) => m.key), ['2026-05', '2026-06', '2026-07']);
  assert.equal(months[0].days.length, 31);
  assert.equal(months[1].days.length, 30);        // June, entirely unwritten
  assert.ok(months[1].days.every((d) => !d.written));
  const may9 = months[0].days.find((d) => d.date === '2026-05-09');
  assert.deepEqual(may9, { date: '2026-05-09', written: true, mood: 4, energy: 2 });
  const jul2 = months[2].days.find((d) => d.date === '2026-07-02');
  assert.equal(jul2.written, true);
  assert.equal(jul2.mood, 2);
});

test('buildYear — February length follows the leap year', () => {
  assert.equal(buildYear([{ day: '2024-02-10' }])[0].days.length, 29);
  assert.equal(buildYear([{ day: '2026-02-10' }])[0].days.length, 28);
});
