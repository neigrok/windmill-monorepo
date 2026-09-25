import test from 'node:test';
import assert from 'node:assert/strict';
import { correctionDraft, correctionWrite, readSetFields } from '../../../../src/products/gym/correction/correction.js';

test('whole-workout correction preserves actual facts, shifts instants and renumbers per movement', () => {
  const session = { id: 'ses_a', startedAt: new Date(2026, 8, 7, 18).getTime(), finishedAt: new Date(2026, 8, 7, 19).getTime(), plan: { routine: 'Push A' } };
  const sets = [{ id: 'set_a', exerciseId: 'bench', setNumber: 1, kind: 'warmup', weightKg: 40, reps: 8, rpe: 7, note: 'steady', completedAt: session.startedAt + 600000 }];
  const draft = correctionDraft(session, sets);
  draft.date = '2026-09-08';
  draft.sets.push({ id: 'set_b', exerciseId: 'bench', fields: { weightKg: '60', reps: '8', rpe: '', note: '' } });
  const moved = 86400000;
  assert.deepEqual(correctionWrite(session, draft, 'fix_a', session.finishedAt + moved * 2), { value: {
    requestId: 'fix_a', startedAt: session.startedAt + moved, finishedAt: session.finishedAt + moved, routineName: 'Push A',
    sets: [{ id: 'set_a', exerciseId: 'bench', setNumber: 1, weightKg: 40, reps: 8, rpe: 7, note: 'steady', completedAt: session.startedAt + 600000 + moved }, { id: 'set_b', exerciseId: 'bench', setNumber: 2, weightKg: 60, reps: 8, rpe: null, note: '', completedAt: session.finishedAt + moved }],
  } });
  assert.equal('kind' in correctionWrite(session, draft, 'fix_a', session.finishedAt + moved * 2).value.sets[0], false);
});

test('refused text remains in the draft and identifies its exact input without clamping it', () => {
  const fields = { weightKg: '501', reps: '8', rpe: '', note: '' };
  assert.deepEqual(readSetFields(fields), { field: 'weightKg', reason: 'Over 500 kg — check the number.' });
  assert.deepEqual(fields, { weightKg: '501', reps: '8', rpe: '', note: '' });
  assert.deepEqual(readSetFields({ ...fields, weightKg: '-20,5' }), { value: { weightKg: -20.5, reps: 8, rpe: null, note: '' } });
  assert.deepEqual(readSetFields({ ...fields, weightKg: '60', reps: '1.5' }), { field: 'reps', reason: 'Enter 1 to 500 reps.' });
});

test('editing a set preserves the workout’s original sub-minute instants and rejects non-decimal input', () => {
  const session = { id: 'ses_a', startedAt: new Date(2026, 8, 7, 18, 0, 23, 450).getTime(), finishedAt: new Date(2026, 8, 7, 19, 1, 46, 900).getTime(), routineName: 'Push A' };
  const sets = [{ id: 'set_a', exerciseId: 'bench', setNumber: 1, kind: 'working', weightKg: 40, reps: 8, completedAt: session.startedAt + 12000 }];
  const draft = correctionDraft(session, sets);
  draft.sets[0].fields.weightKg = '42.5';
  const result = correctionWrite(session, draft, 'fix_a', session.finishedAt + 1).value;
  assert.deepEqual([result.startedAt, result.finishedAt, result.sets[0].completedAt], [session.startedAt, session.finishedAt, sets[0].completedAt]);
  assert.deepEqual(readSetFields({ weightKg: '0x20', reps: '8', rpe: '', note: '' }), { field: 'weightKg', reason: 'Enter a load from −500 to 500 kg.' });
  assert.deepEqual(readSetFields({ weightKg: '−20,5', reps: '8', rpe: '', note: '' }), { value: { weightKg: -20.5, reps: 8, rpe: null, note: '' } });
});


test('correction preserves backend-valid high reps and historical RPE values', () => {
  const fields = { weightKg: '60', reps: '500', rpe: '5.3', note: '' };
  assert.deepEqual(readSetFields(fields), { value: { weightKg: 60, reps: 500, rpe: 5.3, note: '' } });
  assert.deepEqual(readSetFields({ ...fields, reps: '501' }), { field: 'reps', reason: 'Enter 1 to 500 reps.' });
  assert.deepEqual(readSetFields({ ...fields, rpe: '5.33' }), { field: 'rpe', reason: 'Enter an RPE from 1 to 10 with at most one decimal.' });
});

test('an unchanged local time keeps its exact DST-fold instant and an edited DST-gap time is refused', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const session = { id: 'ses_fold', startedAt: Date.parse('2026-11-01T01:30:23-05:00'), finishedAt: Date.parse('2026-11-01T02:00:23-05:00'), routineName: 'Push A' };
    const sets = [{ id: 'set_a', exerciseId: 'bench', setNumber: 1, kind: 'working', weightKg: 60, reps: 101, rpe: 5, completedAt: session.startedAt + 12000 }];
    const draft = correctionDraft(session, sets);
    draft.sets[0].fields.weightKg = '62.5';
    const write = correctionWrite(session, draft, 'fix_a', session.finishedAt + 1).value;
    assert.deepEqual([write.startedAt, write.finishedAt, write.sets[0].completedAt, write.sets[0].rpe, write.sets[0].reps], [session.startedAt, session.finishedAt, sets[0].completedAt, 5, 101]);
    draft.date = '2026-03-08';
    draft.time = '02:30';
    assert.deepEqual(correctionWrite(session, draft, 'fix_b', session.finishedAt + 1), { field: 'date', reason: 'Enter a valid local date and time for this workout.' });
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
