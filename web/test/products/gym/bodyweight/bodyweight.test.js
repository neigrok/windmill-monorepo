import test from 'node:test';
import assert from 'node:assert/strict';

import {
  axisValue, BODYWEIGHT_TITLE, chartCaption, chartDomainOf, chartPointsOf, dateLocalOf,
  DEFAULT_WINDOW, DELETE_VERB, entriesAfter, GAP_DAYS, gapLabel, joinsAcross, latestOf,
  msOfDateLocal, parseWeighIn, readingLine, REFUSALS, saveRefusal, WEIGH_IN_DELETED, WEIGH_IN_VERB,
  weighInWrite, weightReading, WINDOWS, windowOf, windowStartOf,
} from '../../../../src/products/gym/bodyweight/bodyweight.js';
import { GymError } from '../../../../src/products/gym/gymApi.js';
import { KG, LB, spellWeightsIn } from '../../../../src/products/gym/units.js';

test.afterEach(() => spellWeightsIn(KG));

const NOW = new Date(2026, 7, 26, 9, 30).getTime();

test('the words are the pinned ones', () => {
  assert.equal(BODYWEIGHT_TITLE, 'Bodyweight');
  assert.equal(WEIGH_IN_VERB, 'Weigh in');
  assert.deepEqual(REFUSALS, {
    notNumber: 'That is not a number yet.',
    decimals: 'One decimal point only.',
    bounds: 'Between 20 and 400 kg — check the number.',
    future: 'A weigh-in is not a forecast — today or earlier.',
  });
  assert.equal(GAP_DAYS, 7);
  assert.deepEqual(WINDOWS.map((window) => window.label), ['90 days', 'All']);
  assert.equal(DEFAULT_WINDOW, '90');
  assert.equal(DELETE_VERB, 'Delete weigh-in');
  assert.equal(WEIGH_IN_DELETED, 'Weigh-in deleted.');
});

test('dateLocalOf and msOfDateLocal — the lifter’s own calendar date, and only a real one', () => {
  assert.equal(dateLocalOf(new Date(2026, 7, 26, 23, 59).getTime()), '2026-08-26');
  assert.equal(dateLocalOf(new Date(2026, 0, 3, 0, 1).getTime()), '2026-01-03');
  assert.equal(msOfDateLocal('2026-08-26'), new Date(2026, 7, 26).getTime());
  assert.equal(msOfDateLocal('2026-02-30'), null);
  assert.equal(msOfDateLocal('2026-8-6'), null);
  assert.equal(msOfDateLocal('2026-13-01'), null);
  assert.equal(msOfDateLocal(''), null);
  assert.equal(msOfDateLocal(undefined), null);
});

test('weightReading — the wire’s two decimals with trailing zeros dropped, pounds to a tenth', () => {
  assert.equal(weightReading(82.4), '82.4');
  assert.equal(weightReading(82.45), '82.45');
  assert.equal(weightReading(82), '82');
  assert.equal(weightReading(82.4), '82.4');
  spellWeightsIn(LB);
  assert.equal(weightReading(82.4), '181.7');
  assert.equal(weightReading(100), '220.5');
});

test('readingLine — the last number and its age in calendar days, and nothing at all without one', () => {
  assert.equal(readingLine({ dateLocal: '2026-08-26', weightKg: 82.4 }, NOW), '82.4 kg · today');
  assert.equal(readingLine({ dateLocal: '2026-08-25', weightKg: 82.4 }, NOW), '82.4 kg · yesterday');
  assert.equal(readingLine({ dateLocal: '2026-08-23', weightKg: 82.4 }, NOW), '82.4 kg · 3 days ago');
  assert.equal(readingLine(null, NOW), null);
  assert.equal(readingLine({ dateLocal: 'nope', weightKg: 82.4 }, NOW), null);
  spellWeightsIn(LB);
  assert.equal(readingLine({ dateLocal: '2026-08-23', weightKg: 82.4 }, NOW), '181.7 lb · 3 days ago');
});

test('parseWeighIn — comma or point, one refusal at a time, in the pinned order', () => {
  assert.deepEqual(parseWeighIn('82,4'), { valid: true, weightKg: 82.4 });
  assert.deepEqual(parseWeighIn('82.4'), { valid: true, weightKg: 82.4 });
  assert.deepEqual(parseWeighIn(' 82.45 '), { valid: true, weightKg: 82.45 });
  assert.deepEqual(parseWeighIn('82.456'), { valid: true, weightKg: 82.46 }, 'two decimals, like the wire');
  assert.deepEqual(parseWeighIn('20'), { valid: true, weightKg: 20 });
  assert.deepEqual(parseWeighIn('400'), { valid: true, weightKg: 400 });
  assert.deepEqual(parseWeighIn(''), { valid: false, message: 'That is not a number yet.' });
  assert.deepEqual(parseWeighIn('abc'), { valid: false, message: 'That is not a number yet.' });
  assert.deepEqual(parseWeighIn('-82'), { valid: false, message: 'That is not a number yet.' }, 'a bodyweight is unsigned');
  assert.deepEqual(parseWeighIn('82 kg'), { valid: false, message: 'That is not a number yet.' });
  assert.deepEqual(parseWeighIn('1.2.3'), { valid: false, message: 'One decimal point only.' });
  assert.deepEqual(parseWeighIn('82,4,1'), { valid: false, message: 'One decimal point only.' });
  assert.deepEqual(parseWeighIn('82,4.1'), { valid: false, message: 'One decimal point only.' });
  assert.deepEqual(parseWeighIn('19.99'), { valid: false, message: 'Between 20 and 400 kg — check the number.' });
  assert.deepEqual(parseWeighIn('400.01'), { valid: false, message: 'Between 20 and 400 kg — check the number.' });
  assert.deepEqual(parseWeighIn('1820'), { valid: false, message: 'Between 20 and 400 kg — check the number.' });
});

test('parseWeighIn — in pounds the field is pounds and the wire is still kilograms', () => {
  spellWeightsIn(LB);
  assert.deepEqual(parseWeighIn('180'), { valid: true, weightKg: 81.65 });
  assert.deepEqual(parseWeighIn('181,7'), { valid: true, weightKg: 82.42 });
  assert.deepEqual(parseWeighIn('44'), { valid: false, message: 'Between 20 and 400 kg — check the number.' });
  assert.deepEqual(parseWeighIn('882'), { valid: false, message: 'Between 20 and 400 kg — check the number.' });
});

test('weighInWrite — the row the wire takes, stamped with the device clock, or the refusal to draw', () => {
  assert.deepEqual(weighInWrite('82,4', '2026-08-26', NOW), { dateLocal: '2026-08-26', weightKg: 82.4, recordedAt: NOW });
  assert.deepEqual(weighInWrite('x', '2026-08-26', NOW), { refusal: 'That is not a number yet.' });
  assert.deepEqual(weighInWrite('82.4', '2026-02-30', NOW), { refusal: 'could not read that date' });
  assert.deepEqual(weighInWrite('82.4', '', NOW), { refusal: 'could not read that date' });
});

test('weighInWrite — never a forecast: the device’s local today is the latest date a weigh-in carries', () => {
  assert.deepEqual(weighInWrite('82.4', '2026-08-27', NOW), { refusal: 'A weigh-in is not a forecast — today or earlier.' });
  assert.deepEqual(weighInWrite('82.4', '2031-01-01', NOW), { refusal: 'A weigh-in is not a forecast — today or earlier.' });
  assert.deepEqual(weighInWrite('82.4', '2026-08-26', NOW), { dateLocal: '2026-08-26', weightKg: 82.4, recordedAt: NOW }, 'today is not the future');
  assert.deepEqual(weighInWrite('82.4', '2026-08-25', NOW), { dateLocal: '2026-08-25', weightKg: 82.4, recordedAt: NOW });
  const lateTonight = new Date(2026, 7, 26, 23, 59).getTime();
  assert.deepEqual(weighInWrite('82.4', '2026-08-26', lateTonight).dateLocal, '2026-08-26', 'local today, never UTC tomorrow');
  assert.deepEqual(weighInWrite('x', '2031-01-01', NOW), { refusal: 'That is not a number yet.' }, 'the number’s refusals come first');
  assert.deepEqual(weighInWrite('82.4', '2031-02-30', NOW), { refusal: 'could not read that date' }, 'a date that is not one is not a forecast either');
});

test('joinsAcross — calendar days, not elapsed hours: a week of local midnights joins on either side of a clock change', () => {
  const HOUR = 3600000;
  const at = (hours) => ({ at: hours * HOUR });
  assert.equal(joinsAcross(at(0), at(7 * 24)), true);
  assert.equal(joinsAcross(at(0), at(7 * 24 + 1)), true, '169 hours is the seven days across the autumn change');
  assert.equal(joinsAcross(at(0), at(7 * 24 - 1)), true, '167 hours is the seven days across the spring change');
  assert.equal(joinsAcross(at(0), at(8 * 24)), false);
  assert.equal(joinsAcross(at(0), at(8 * 24 - 1)), false, '191 hours is eight days, not seven and a bit');
  assert.equal(joinsAcross(at(0), at(0)), true);
});

test('joinsAcross — seven weigh-in dates across the autumn change in New York are joined, like any other week', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const points = chartPointsOf([{ dateLocal: '2026-11-01', weightKg: 82 }, { dateLocal: '2026-11-08', weightKg: 82.5 }]);
    assert.equal((points[1].at - points[0].at) / 3600000, 169, 'the week that holds the change runs 169 hours');
    assert.equal(joinsAcross(points[0], points[1]), true);
    const eight = chartPointsOf([{ dateLocal: '2026-11-01', weightKg: 82 }, { dateLocal: '2026-11-09', weightKg: 82.5 }]);
    assert.equal(joinsAcross(eight[0], eight[1]), false);
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('entriesAfter — this screen’s writes fold over the read, one row per date, ascending', () => {
  const read = [
    { dateLocal: '2026-08-20', weightKg: 82.9, recordedAt: 1 },
    { dateLocal: '2026-08-23', weightKg: 82.4, recordedAt: 2 },
  ];
  const moves = new Map([
    ['2026-08-23', { dateLocal: '2026-08-23', weightKg: 82.5, recordedAt: 3 }],
    ['2026-08-21', { dateLocal: '2026-08-21', weightKg: 82.7, recordedAt: 4 }],
    ['2026-08-20', null],
  ]);
  assert.deepEqual(entriesAfter(read, moves), [
    { dateLocal: '2026-08-21', weightKg: 82.7, recordedAt: 4 },
    { dateLocal: '2026-08-23', weightKg: 82.5, recordedAt: 3 },
  ]);
  assert.deepEqual(entriesAfter(undefined, moves), [
    { dateLocal: '2026-08-21', weightKg: 82.7, recordedAt: 4 },
    { dateLocal: '2026-08-23', weightKg: 82.5, recordedAt: 3 },
  ], 'a write that landed before the read answered stands');
  assert.deepEqual(entriesAfter(read, new Map()), read);
  assert.deepEqual(latestOf(entriesAfter(read, moves), NOW), { dateLocal: '2026-08-23', weightKg: 82.5, recordedAt: 3 });
  assert.equal(latestOf([], NOW), null);
});

test('a served row dated after the device’s local today is never the reading and never a dot', () => {
  const today = { dateLocal: '2026-08-26', weightKg: 82.4, recordedAt: 2 };
  const forecast = { dateLocal: '2027-01-05', weightKg: 70, recordedAt: 3 };
  const entries = [{ dateLocal: '2026-08-20', weightKg: 82.9, recordedAt: 1 }, today, forecast];
  assert.deepEqual(latestOf(entries, NOW), today);
  assert.equal(latestOf([forecast], NOW), null, 'a forecast alone is no reading at all');
  assert.deepEqual(latestOf([{ dateLocal: '2026-08-20', weightKg: 82.9, recordedAt: 1 }, { dateLocal: '2026-08-27', weightKg: 70, recordedAt: 3 }], NOW).dateLocal, '2026-08-20', 'tomorrow is a forecast too');
  assert.deepEqual(windowOf(entries, '90', NOW).map((entry) => entry.dateLocal), ['2026-08-20', '2026-08-26']);
  assert.deepEqual(windowOf(entries, 'all', NOW).map((entry) => entry.dateLocal), ['2026-08-20', '2026-08-26']);
  assert.deepEqual(chartPointsOf(windowOf(entries, 'all', NOW)).map((point) => point.dateLocal), ['2026-08-20', '2026-08-26']);
  assert.equal(readingLine(latestOf(entries, NOW), NOW), '82.4 kg · today');
});

test('the window — today and the 89 days before it, or the whole series; its label and range are stated', () => {
  const start = windowStartOf('90', NOW);
  assert.equal(start, new Date(2026, 4, 29).getTime());
  assert.equal(windowStartOf('all', NOW), null);
  const entries = [
    { dateLocal: '2026-05-28', weightKg: 84 },
    { dateLocal: '2026-05-29', weightKg: 83.8 },
    { dateLocal: '2026-08-26', weightKg: 82.4 },
  ];
  assert.deepEqual(windowOf(entries, '90', NOW).map((entry) => entry.dateLocal), ['2026-05-29', '2026-08-26']);
  assert.deepEqual(windowOf(entries, 'all', NOW).map((entry) => entry.dateLocal), ['2026-05-28', '2026-05-29', '2026-08-26']);
  assert.deepEqual(chartDomainOf(entries, '90', NOW), { from: start, to: new Date(2026, 7, 26).getTime() });
  assert.deepEqual(chartDomainOf(entries, 'all', NOW), { from: new Date(2026, 4, 28).getTime(), to: new Date(2026, 7, 26).getTime() });
  assert.deepEqual(chartDomainOf([], 'all', NOW), { from: new Date(2026, 7, 26).getTime(), to: new Date(2026, 7, 26).getTime() });
  assert.equal(chartCaption('90', 3), 'last 90 days · 3 weigh-ins');
  assert.equal(chartCaption('90', 1), 'last 90 days · 1 weigh-in');
  assert.equal(chartCaption('all', 12), 'the whole series · 12 weigh-ins');
  assert.equal(chartCaption('all', 1), 'the whole series · 1 weigh-in');
  assert.deepEqual(WINDOWS.map((window) => window.stated), ['last 90 days', 'the whole series']);
});

test('the unit is on the y-axis labels, in the display unit, and not in the window label', () => {
  assert.equal(axisValue(82.449), '82.4 kg');
  assert.equal(axisValue(82), '82 kg');
  assert.equal(chartCaption('90', 2).includes('kg'), false);
  spellWeightsIn(LB);
  assert.equal(axisValue(181.7), '181.7 lb');
  assert.equal(chartCaption('90', 2), 'last 90 days · 2 weigh-ins');
});

test('chartPointsOf and gapLabel — a dot per row in the display unit, and the gap named by its two ends', () => {
  const points = chartPointsOf([{ dateLocal: '2026-07-07', weightKg: 82.4 }, { dateLocal: '2026-08-04', weightKg: 82 }]);
  assert.deepEqual(points, [
    { key: '2026-07-07', at: new Date(2026, 6, 7).getTime(), value: 82.4, label: '82.4 kg · 7 Jul', dateLocal: '2026-07-07' },
    { key: '2026-08-04', at: new Date(2026, 7, 4).getTime(), value: 82, label: '82 kg · 4 Aug', dateLocal: '2026-08-04' },
  ]);
  assert.equal(gapLabel(points[0], points[1]), 'no weigh-in · 7 Jul – 4 Aug');
  assert.equal(chartPointsOf([{ dateLocal: 'nope', weightKg: 82 }]).length, 0);
  spellWeightsIn(LB);
  assert.equal(chartPointsOf([{ dateLocal: '2026-07-07', weightKg: 82.4 }])[0].label, '181.7 lb · 7 Jul');
});

test('saveRefusal — the store’s sentence where it sent one', () => {
  assert.equal(saveRefusal(new GymError(400, 'Between 20 and 400 kg — check the number.')), 'Between 20 and 400 kg — check the number.');
  assert.equal(saveRefusal(new GymError(400, 'could not read that date')), 'could not read that date');
  assert.equal(saveRefusal(new GymError(401)), 'You’re signed out. Sign in and try again.');
  assert.equal(saveRefusal(new GymError(503)), 'That weigh-in wasn’t saved — the log didn’t answer. Try again when you have signal.');
  assert.equal(saveRefusal(new TypeError('fetch failed')), 'That weigh-in wasn’t saved — the log didn’t answer. Try again when you have signal.');
});
