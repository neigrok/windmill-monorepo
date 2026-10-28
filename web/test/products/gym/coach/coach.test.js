import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerTurn, askFailure, coachWorkout, draftEntryLine, generationTurns, mergeTurns, questionTooLong, readLine, stepsLine,
} from '../../../../src/products/gym/coach/coach.js';

test('live mirror uses frozen targets and actual sets without comparing ambiguous or unplanned movements', () => {
  const session = { startedAt: 0, plan: { routine: 'Push', entries: [
    { exerciseId: 'bench', sets: [{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }] },
    { exerciseId: 'chin', sets: [{ weightKg: 0, reps: 6 }] },
  ] } };
  const sets = [{ id: 'set_1', exerciseId: 'bench', weightKg: 62.5, reps: 7, setNumber: 1, completedAt: 1 }];
  const catalog = [{ id: 'bench', name: 'Bench Press' }, { id: 'chin', name: 'Chin-up', equipment: 'bodyweight' }];
  const result = coachWorkout(session, sets, catalog);
  assert.deepEqual({ ...result, started: 'local time' }, { name: 'Push', started: 'local time', count: '1 set logged', progress: 'set 2 of 3', active: 'bench', groups: [
    { id: 'bench', name: 'Bench Press', scheme: '2 × 8 · 60', targets: 2, rows: [
      { key: 'set_1', kind: 'lifted', label: '62.5 × 7' },
      { key: 'slot-2', kind: 'target', label: '60 × 8', spoken: 'set 2, target 60 × 8' },
    ] },
    { id: 'chin', name: 'Chin-up', scheme: '1 × 6 · 0 · bodyweight', targets: 1, rows: [{ key: 'slot-1', kind: 'target', label: '0 × 6', spoken: 'set 1, target 0 × 6' }] },
  ] });
  const ambiguous = coachWorkout({ ...session, plan: { entries: [session.plan.entries[0], session.plan.entries[0]] } }, sets, catalog);
  assert.deepEqual(ambiguous.groups, [{ id: 'bench', name: 'Bench Press', scheme: null, targets: null, rows: [{ key: 'set_1', kind: 'lifted', label: '62.5 × 7' }] }]);
  assert.equal(ambiguous.progress, '1 working set logged');
  assert.deepEqual(coachWorkout({ startedAt: 0, plan: '{bad json' }, [], []).groups, []);
});

test('extra sets on one movement never consume another movement’s planned slots', () => {
  const session = { startedAt: 0, plan: { entries: ['bench', 'press'].map((exerciseId) => ({ exerciseId,
    sets: Array.from({ length: 3 }, () => ({ weightKg: 60, reps: 8 })) })) } };
  const sets = Array.from({ length: 5 }, (_, index) => ({ id: `set_${index}`, exerciseId: 'bench',
    setNumber: index + 1, completedAt: index, weightKg: 60, reps: 8 }));
  sets.push({ id: 'set_light', exerciseId: 'press', setNumber: 1, completedAt: 6, weightKg: 20, reps: 8 });
  const workout = coachWorkout(session, sets);
  const lifted = (key, label) => ({ key, kind: 'lifted', label });
  const target = (n) => ({ key: `slot-${n}`, kind: 'target', label: '60 × 8', spoken: `set ${n}, target 60 × 8` });
  assert.deepEqual({ ...workout, started: 'local time' }, { name: 'Free session', started: 'local time', count: '6 sets logged', progress: 'set 5 of 6', active: 'press', groups: [
    { id: 'bench', name: 'bench', scheme: '3 × 8 · 60', targets: 3, rows: [0, 1, 2, 3, 4].map((index) => lifted(`set_${index}`, '60 × 8')) },
    { id: 'press', name: 'press', scheme: '3 × 8 · 60', targets: 3, rows: [lifted('set_light', '20 × 8'), target(2), target(3)] },
  ] });
});

test('read receipts preserve the server counts, including a real zero, and never invent missing counts', () => {
  assert.equal(readLine({ sets: 214, sessions: 34, weeks: 12 }), 'read 214 sets · 12 weeks · 34 sessions');
  assert.equal(readLine({ sets: 1, sessions: 1, weeks: 1 }), 'read 1 set · 1 week · 1 session');
  assert.equal(readLine({ sets: 0, sessions: 0, weeks: 0 }), 'read nothing from your log');
  assert.equal(readLine({ sets: '12', sessions: 3, weeks: 1 }), null);
  assert.equal(readLine({ sets: 12, weeks: 1 }), null);
  assert.equal(readLine(null), null);
});

test('tool descriptions are ordered, deduplicated and bounded to known facts', () => {
  const steps = [{ tool: 'list_notes' }, { tool: 'list_notes' }, { tool: 'list_exercises', failed: true }, { tool: 'create_routine' }];
  assert.equal(stepsLine(steps, { drafted: true }), 'It read your notes, then read your movement list (nothing came back), then drafted a routine for your review.');
  assert.equal(stepsLine(steps), 'It read your notes, then read your movement list (nothing came back), then created a routine.');
  assert.equal(stepsLine([{ tool: 'update_exercise' }]), 'It updated a movement.');
  assert.equal(stepsLine([{ tool: 'save_note' }, { tool: 'save_note' }]), 'It saved a note.');
  assert.equal(stepsLine([{ tool: 'save_note', failed: true }]), 'It could not confirm a note save.');
  assert.equal(stepsLine([{ tool: 'new_tool' }]), null);
  assert.equal(stepsLine([]), 'Answered from your recent workouts alone.');
});

test('legacy answers retain their read and proposal receipt without guessing missing facts', () => {
  const reply = { answer: 'Three sets.', read: { sets: 3, sessions: 1, weeks: 1 }, proposals: ['prop_1'] };
  assert.deepEqual(answerTurn(reply), { from: 'ask', text: 'Three sets.', read: reply.read, steps: undefined, proposals: ['prop_1'] });
  assert.equal(answerTurn({ answer: 'Three sets.' }), null);
  assert.equal(answerTurn({ read: reply.read }), null);
});

test('server refusal sentences and scopes stay exact and only unaccepted questions are refused', () => {
  assert.deepEqual(askFailure({ status: 429, code: 'ask-out-of-budget', detail: 'Thirty-day allowance spent.' }),
    { note: 'Thirty-day allowance spent.', capped: true, ceiling: true, refused: true });
  assert.deepEqual(askFailure({ status: 429, code: 'ask-daily-limit', detail: 'Come back later.' }),
    { note: 'Come back later.', capped: true, refused: true });
  assert.deepEqual(askFailure({ status: 502, detail: 'Try again.' }), { note: 'Try again.' });
  assert.equal(askFailure({ status: 409, code: 'ask-generation-active' }).refused, true);
  assert.equal(askFailure({ status: 401 }).gone, true);
  assert.equal(askFailure({ status: 400 }).refused, true);
  assert.equal(askFailure({ status: 503 }).gone, undefined);
});

test('UTF-8 bytes bound a question, including multibyte characters', () => {
  assert.equal(questionTooLong('a'.repeat(1000)), false);
  assert.equal(questionTooLong('a'.repeat(1001)), true);
  assert.equal(questionTooLong('é'.repeat(500)), false);
  assert.equal(questionTooLong('é'.repeat(501)), true);
});

test('failed generation retry replaces its existing pair and retains historical receipts', () => {
  const receipt = { read: { sets: 4, sessions: 1, weeks: 1 }, proposals: ['prop_1'], observations: [{ id: 'ses_1' }] };
  const generation = { id: 'gen_1', requestId: 'ask_1', at: 10, question: 'Make a routine.',
    status: 'failed', answer: '', receipt,
    results: [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }] };
  const held = generationTurns(generation).map((turn, position) => ({ ...turn, position }));
  const completed = generationTurns({ ...generation, status: 'completed', answer: 'Routine created.' });
  const merged = mergeTurns(held, completed);
  assert.deepEqual(merged, completed.map((turn, position) => ({ ...turn, position })));
  assert.equal(merged[1].receipt, receipt);
  assert.equal(merged.length, 2);
});

test('overlapping pages merge by server position with ordered complete messages', () => {
  const turns = Array.from({ length: 300 }, (_, position) => ({ position, from: position % 2 ? 'ask' : 'lifter', text: String(position), at: position }));
  const latest = turns.slice(250);
  const older = turns.slice(200, 260);
  assert.deepEqual(mergeTurns(latest, older), turns.slice(200));
  assert.deepEqual(mergeTurns(mergeTurns(latest, older), turns.slice(0, 210)), turns);
});

test('stale history cannot revert a confirmed routine draft or lose its receipt', () => {
  const draft = { operationId: 'op1', routineId: 'rt1', name: 'Push', position: 1, entries: [], state: 'saved' };
  const saved = { from: 'ask', requestId: 'request1', routineDrafts: [draft], revision: 5,
    results: [{ kind: 'routine-created', operationId: 'op1', routineId: 'rt1', routineName: 'Push' }] };
  assert.deepEqual(mergeTurns([saved], [{ ...saved, revision: 4, routineDrafts: [{ ...draft, state: 'pending' }], results: [] }]), [saved]);
  assert.deepEqual(mergeTurns([saved], [{ from: 'ask', requestId: 'request1', routineDrafts: [{ ...draft, state: 'pending' }], results: [] }]), [saved]);
});

test('a draft line names its movement as the log knows it, its load basis in the lifter’s unit, and nothing the log does not know', () => {
  const catalog = [{ id: 'pull-up', name: 'Pull Up', equipment: 'bodyweight' }, { id: 'goblet-squat', name: 'Goblet Squat', equipment: 'dumbbell', loadCount: 1 }];
  assert.deepEqual([
    draftEntryLine({ exerciseId: 'pull-up', sets: [{ reps: 8, weightKg: -10 }] }, catalog),
    draftEntryLine({ exerciseId: 'goblet-squat', sets: [{ reps: 8, weightKg: 24 }], restSeconds: 90 }, catalog),
    draftEntryLine({ exerciseId: 'ex_new_custom', sets: [{ reps: 8, weightKg: 16 }] }, catalog),
    draftEntryLine({ exerciseId: 'pull-up', sets: [{ reps: 8 }] }, catalog),
  ], [
    { name: 'Pull Up', detail: '1 × 8 · −10 kg assisted · Bodyweight' },
    { name: 'Goblet Squat', detail: '1 × 8 · 24 kg · One dumbbell · 90s rest' },
    { name: 'New movement', detail: '1 × 8 · 16' },
    { name: 'Pull Up', detail: '1 × 8 · Bodyweight' },
  ]);
});
