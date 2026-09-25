import test from 'node:test';
import assert from 'node:assert/strict';
import { spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { historyTotals } from '../../../../src/products/gym/logbook/history.js';
import { tonnageLabel } from '../../../../src/products/gym/log.js';
import { consistencyLine, joinsSessions, movementProgress, progressCards, sessionGapLabel } from '../../../../src/products/gym/progress/progress.js';

test('all is the full qualified snapshot, with one earliest standing mark and true time gaps', () => {
  const day = (month, date) => new Date(2026, month - 1, date, 12).getTime();
  const sessions = [
    { sessionId: 'a', startedAt: day(1, 1), movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { weightKg: 100, reps: 1 }, estimate: { weightKg: 100, reps: 1, e1rm: 100 } }] },
    { sessionId: 'b', startedAt: day(8, 1), movements: [{ exerciseId: 'bench', workingSetCount: 2, heaviest: { weightKg: 70, reps: 12 } }] },
    { sessionId: 'c', startedAt: day(9, 1), movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { weightKg: 80, reps: 5 }, estimate: { weightKg: 80, reps: 5, e1rm: 93.3333333333333 } }] },
    { sessionId: 'd', startedAt: day(9, 8), movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { weightKg: 100, reps: 1 }, estimate: { weightKg: 100, reps: 1, e1rm: 100 } }] },
  ];
  const all = movementProgress({ sessions }, 'bench', { equipment: 'barbell', window: 'all', now: day(9, 25) });
  assert.deepEqual(all.points.map(({ key, color }) => ({ key, color })), [{ key: 'a', color: 'var(--pr-ink)' }, { key: 'c', color: 'var(--color-brand)' }, { key: 'd', color: 'var(--color-brand)' }]);
  assert.equal(all.windowLabel, 'the whole series · 3 sessions');
  assert.equal(all.domain.to, day(9, 25));
  assert.equal(joinsSessions(all.points[0], all.points[1]), false);
  assert.equal(sessionGapLabel(all.points[0], all.points[1]), 'no session · 1 Jan – 1 Sep');
  assert.equal(joinsSessions(all.points[1], all.points[2]), true);
  const recent = movementProgress({ sessions }, 'bench', { equipment: 'barbell', now: day(9, 25) });
  assert.deepEqual(recent.points.map((point) => point.key), ['c', 'd']);
  assert.equal(recent.points.some((point) => point.color === 'var(--pr-ink)'), false);
  assert.equal(recent.sparseLine, '3 sessions · since 1 Aug');
  assert.equal(recent.chartReady, false);
});

test('the card needs four estimates over three weeks and never invents an assisted estimate', () => {
  const start = new Date(2026, 8, 1, 12).getTime();
  const sessions = Array.from({ length: 4 }, (_, index) => ({ sessionId: `s${index}`, startedAt: start + index * 7 * 86400000, movements: [{ exerciseId: 'squat', workingSetCount: 1, heaviest: { weightKg: 90, reps: 5 }, estimate: { weightKg: 90, reps: 5, e1rm: 105 } }, { exerciseId: 'chin', workingSetCount: 1, heaviest: { weightKg: -20, reps: 8 } }] }));
  const cards = progressCards({ sessions }, [{ id: 'squat', name: 'Back Squat', equipment: 'barbell' }, { id: 'chin', name: 'Chin Up', equipment: 'bodyweight' }], start + 24 * 86400000);
  assert.deepEqual(cards.map((card) => ({ name: card.name, ready: card.chartReady, points: card.points.length })), [{ name: 'Back Squat', ready: true, points: 4 }, { name: 'Chin Up', ready: false, points: 0 }]);
  assert.equal(cards[1].sparseBest, null);
});

test('consistency counts local Monday weeks, stays absent for zero and needs two trained weeks', () => {
  const now = new Date(2026, 8, 25, 12).getTime();
  const at = (date, workingSetCount = 1) => ({ startedAt: new Date(2026, 8, date, 12).getTime(), movements: [{ workingSetCount }] });
  assert.equal(consistencyLine({ sessions: [at(25)] }, now), null);
  assert.equal(consistencyLine({ sessions: [at(25), at(21), at(20), at(15), at(7, 0)] }, now), 'Trained 2 of the last 4 weeks');
  assert.equal(consistencyLine({ sessions: [at(1), at(-6)] }, new Date(2026, 10, 1).getTime()), null);
});

test('bodyweight and unknown equipment hide estimates even for positive added load', () => {
  const now = new Date(2026, 8, 25).getTime();
  const snapshot = { sessions: [{ sessionId: 'a', startedAt: now, movements: [{ exerciseId: 'chin', workingSetCount: 2, heaviest: { weightKg: 10, reps: 6 }, mostReps: { weightKg: 0, reps: 12 }, estimate: { weightKg: 10, reps: 6, e1rm: 12 } }] }] };
  for (const equipment of ['bodyweight', undefined, 'unknown']) {
    const model = movementProgress(snapshot, 'chin', { now, equipment });
    assert.deepEqual({ points: model.points, best: model.best, chart: model.chartReady, mostReps: model.mostRepsLine, signed: model.signedLoadLine }, { points: [], best: null, chart: false, mostReps: 'most reps 12 · bodyweight · 25 Sep', signed: 'heaviest added +10 · 25 Sep' });
  }
});


test('public kilogram facts do not inherit or mutate an owner pound preference', () => {
  const now = new Date(2026, 8, 25).getTime();
  const snapshot = { sessions: [{ sessionId: 'a', startedAt: now, movements: [{ exerciseId: 'bench', workingSetCount: 1, heaviest: { weightKg: 90, reps: 5 }, estimate: { weightKg: 90, reps: 5, e1rm: 105 } }] }] };
  spellWeightsIn('lb');
  try {
    const owner = movementProgress(snapshot, 'bench', { now, equipment: 'barbell' });
    const shared = movementProgress(snapshot, 'bench', { now, equipment: 'barbell', unit: 'kg' });
    assert.deepEqual({ point: owner.points[0].value, heaviest: owner.heaviestLine }, { point: 231.5, heaviest: 'heaviest 198.4 × 5 · 25 Sep' });
    assert.deepEqual({ point: shared.points[0].value, label: shared.points[0].label, heaviest: shared.heaviestLine, best: shared.bestLine }, { point: 105, label: '105 kg est · 25 Sep · 90 × 5', heaviest: 'heaviest 90 × 5 · 25 Sep', best: 'best e1RM 105 · 25 Sep' });
    assert.equal(tonnageLabel(2000, 'kg'), '2,000');
    assert.equal(historyTotals({ sessions: 1, sets: 1, reps: 5 }, 'kg'), '1 workout · 1 sets · 5 reps · loads in kg');
    assert.equal(weightUnit(), 'lb');
  } finally { spellWeightsIn('kg'); }
});
