import test from 'node:test';
import assert from 'node:assert/strict';

import { modalHour, nextNudge } from '../../../src/products/journal/rhythm.js';

test('modalHour — the most-written hour, ties breaking to the earlier one, default when empty', () => {
  assert.equal(modalHour([9, 9, 21, 21, 21, 7]), 21);
  assert.equal(modalHour([8, 8, 20, 20]), 8);
  assert.equal(modalHour([]), 20);
  assert.equal(modalHour([], 6), 6);
});

test('nextNudge — with no history, a gentle evening default at least a lead-time out, on the minute', () => {
  const now = new Date(2026, 0, 15, 13, 0, 0).getTime();
  const { nextDueAt, slotDay, hour } = nextNudge([], now);
  const at = new Date(nextDueAt);
  assert.equal(hour, 20);
  assert.equal(at.getHours(), 20);
  assert.equal(at.getMinutes(), 0);
  assert.equal(at.getSeconds(), 0);
  assert.ok(nextDueAt - now >= 20 * 60 * 60 * 1000);
  assert.equal(slotDay, `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`);
});

test('nextNudge — the knock lands at the hour the writer usually writes', () => {
  const at7 = (day) => ({ updatedAt: new Date(2026, 0, day, 7, 30, 0).getTime() });
  const pages = [at7(1), at7(2), at7(3), { updatedAt: new Date(2026, 0, 4, 22, 0, 0).getTime() }];
  const now = new Date(2026, 0, 15, 13, 0, 0).getTime();
  const { nextDueAt, hour } = nextNudge(pages, now);
  assert.equal(hour, 7);
  assert.equal(new Date(nextDueAt).getHours(), 7);
});
