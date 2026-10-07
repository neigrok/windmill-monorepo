import test from 'node:test';
import assert from 'node:assert/strict';
import {
  axisValue, BODYWEIGHT_TITLE, chartCaption, chartPointsOf, DEFAULT_WINDOW, deleteRefusal, DELETE_VERB,
  gapLabel, readingLine, REFUSALS, saveRefusal, WEIGH_IN_DELETED, WEIGH_IN_VERB, weightReading, WINDOWS,
} from '../../../../src/products/gym/bodyweight/bodyweight.js';
import { gymMoment, weighInInput } from '../../../../src/products/gym/gymRuntime.js';
import { CommitError } from '../../../../src/platform/sync/client/commit.js';
import { GymRefusal } from '../../../../src/products/gym/errors.js';
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
  assert.deepEqual(WINDOWS.map((window) => window.label), ['90 days', 'All']);
  assert.equal(DEFAULT_WINDOW, '90');
  assert.equal(DELETE_VERB, 'Delete weigh-in');
  assert.equal(WEIGH_IN_DELETED, 'Weigh-in deleted.');
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

test('saveRefusal — the log’s sentence where it refused, this device where its store failed, and the wordless fallback otherwise', () => {
  assert.equal(saveRefusal(new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' })), 'Sign in to save to your training log.');
  assert.equal(saveRefusal(new GymRefusal('invalid')), 'The log wouldn’t take this change as written.');
  assert.equal(saveRefusal(new CommitError('the device store did not commit', 'store', { cause: new DOMException('storage refused', 'QuotaExceededError') })), 'That weigh-in wasn’t saved — this device couldn’t store it.');
  assert.equal(saveRefusal(undefined), 'That weigh-in wasn’t saved — the log didn’t answer. Try again when you have signal.');
});

test('deleteRefusal — this device where its store failed, and the brief’s sentence otherwise', () => {
  assert.equal(deleteRefusal(new CommitError('the device store did not commit', 'store', { cause: new DOMException('storage refused', 'QuotaExceededError') })), 'That weigh-in wasn’t deleted — this device couldn’t store it.');
  assert.equal(deleteRefusal(new GymRefusal('not-writable', { sentence: 'Sign in to save to your training log.' })), 'That weigh-in wasn’t deleted. Try again in a moment.');
});

test('the decimal field accepts comma or point and validates through the domain', () => {
  const input = (text, date = '2026-08-26') => weighInInput(text, date, gymMoment(NOW));
  for (const text of ['82,456', '82.456', ' 82.456 ']) {
    assert.deepEqual(input(text), { dateLocal: '2026-08-26', weightKg: 82.46 });
  }
  for (const text of ['', 'abc', '-82', '82 kg']) assert.deepEqual(input(text), { refusal: REFUSALS.notNumber });
  for (const text of ['1.2.3', '82,4,1', '82,4.1']) assert.deepEqual(input(text), { refusal: REFUSALS.decimals });
  for (const text of ['19.99', '400.01', '1820']) assert.deepEqual(input(text), { refusal: REFUSALS.bounds });
  assert.deepEqual(input('82', '2026-08-27'), { refusal: REFUSALS.future });
  assert.deepEqual(input('82', '2026-02-30'), { refusal: 'could not read that date' });
  spellWeightsIn(LB);
  assert.deepEqual(input('180'), { dateLocal: '2026-08-26', weightKg: 81.65 });
  assert.deepEqual(input('44'), { refusal: REFUSALS.bounds });
});
