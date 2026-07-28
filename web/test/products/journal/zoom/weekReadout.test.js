import test from 'node:test';
import assert from 'node:assert/strict';

import { weekReadout } from '../../../../src/products/journal/zoom/weekReadout.js';

test('weekReadout — the seven days ending today, oldest first, counting only what was written', () => {
  const pages = [
    { day: '2026-07-28', body: 'a b c', mood: 5, energy: 3 },
    { day: '2026-07-26', body: 'one two', mood: 2, energy: 1 },
    { day: '2026-07-22', body: 'far', mood: 1, energy: 1 },
    { day: '2026-07-21', body: 'outside the week', mood: 3, energy: 2 },
  ];
  const week = weekReadout(pages, '2026-07-28');
  assert.equal(week.of, 7);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].date, '2026-07-22');
  assert.equal(week.days[6].date, '2026-07-28');
  assert.equal(week.written, 3, '21st is a day too early and is not counted');
  assert.equal(week.totalWords, 6, '3 + 2 + 1 words');
  assert.equal(week.days[6].mood, 5);
  assert.equal(week.days[1].written, false);   // the 23rd, blank
});

test('weekReadout — a blank week reads as zero, still seven days', () => {
  const week = weekReadout([], '2026-07-28');
  assert.equal(week.written, 0);
  assert.equal(week.totalWords, 0);
  assert.equal(week.days.length, 7);
  assert.ok(week.days.every((d) => !d.written && d.words === 0));
});
