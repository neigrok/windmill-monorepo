import test from 'node:test';
import assert from 'node:assert/strict';

import { browserTimezone, describeSchedule, reminderPatch } from '../../../../src/products/roadmap/reminders/remindersClient.js';

test('reminderPatch — switching off needs nothing but the flag', () => {
  assert.deepEqual(reminderPatch(false, 'Europe/Berlin'), { enabled: false });
  assert.deepEqual(reminderPatch(false, ''), { enabled: false });
  assert.deepEqual(reminderPatch(false, null), { enabled: false });
});

test('reminderPatch — switching on carries this browser\'s zone', () => {
  assert.deepEqual(reminderPatch(true, 'Europe/Berlin'), { enabled: true, timezone: 'Europe/Berlin' });
  assert.deepEqual(reminderPatch(true, '  America/New_York  '), { enabled: true, timezone: 'America/New_York' });
});

test('reminderPatch — enabling without a zone is not a request worth sending', () => {
  assert.equal(reminderPatch(true, ''), null);
  assert.equal(reminderPatch(true, '   '), null);
  assert.equal(reminderPatch(true, null), null);
  assert.equal(reminderPatch(true, undefined), null);
});

test('browserTimezone — names this runtime\'s IANA zone', () => {
  const zone = browserTimezone();
  assert.equal(typeof zone, 'string');
  assert.equal(zone.length > 0, true);
  assert.equal(zone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('browserTimezone — a runtime that will not name one answers with the empty string', () => {
  const real = globalThis.Intl;
  globalThis.Intl = { DateTimeFormat() { throw new Error('no ICU here'); } };
  try {
    assert.equal(browserTimezone(), '');
  } finally {
    globalThis.Intl = real;
  }
});

test('describeSchedule — the standing slot reads as Tuesdays around 9am', () => {
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 540 }), 'Tuesdays around 9am');
});

test('describeSchedule — every day of the week, 1=Mon through 7=Sun', () => {
  const days = [1, 2, 3, 4, 5, 6, 7].map((slotDow) => describeSchedule({ slotDow, slotMinute: 540 }));
  assert.deepEqual(days, [
    'Mondays around 9am',
    'Tuesdays around 9am',
    'Wednesdays around 9am',
    'Thursdays around 9am',
    'Fridays around 9am',
    'Saturdays around 9am',
    'Sundays around 9am',
  ]);
});

test('describeSchedule — the hour reads in twelves, and a whole hour drops its minutes', () => {
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 0 }), 'Tuesdays around 12am');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 480 }), 'Tuesdays around 8am');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 570 }), 'Tuesdays around 9:30am');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 605 }), 'Tuesdays around 10:05am');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 660 }), 'Tuesdays around 11am');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 720 }), 'Tuesdays around 12pm');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 780 }), 'Tuesdays around 1pm');
  assert.equal(describeSchedule({ slotDow: 2, slotMinute: 1439 }), 'Tuesdays around 11:59pm');
});

test('describeSchedule — a slot off the wire that makes no sense falls back to the standing one', () => {
  assert.equal(describeSchedule({ slotDow: 0, slotMinute: 540 }), 'Tuesdays around 9am');
  assert.equal(describeSchedule({ slotDow: 8, slotMinute: 540 }), 'Tuesdays around 9am');
  assert.equal(describeSchedule({ slotDow: undefined, slotMinute: undefined }), 'Tuesdays around 9am');
  assert.equal(describeSchedule({ slotDow: 3, slotMinute: -1 }), 'Wednesdays around 9am');
  assert.equal(describeSchedule({ slotDow: 3, slotMinute: 1440 }), 'Wednesdays around 9am');
  assert.equal(describeSchedule({ slotDow: 3, slotMinute: 9.5 }), 'Wednesdays around 9am');
});
