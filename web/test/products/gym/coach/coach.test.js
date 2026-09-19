import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerTurn, askFailure, generationTurns, mergeTurns, questionTooLong, readLine, stepsLine,
} from '../../../../src/products/gym/coach/coach.js';

test('read receipts preserve the server counts, including a real zero, and never invent missing counts', () => {
  assert.equal(readLine({ sets: 214, sessions: 34, weeks: 12 }), 'read 214 sets · 12 weeks · 34 sessions');
  assert.equal(readLine({ sets: 1, sessions: 1, weeks: 1 }), 'read 1 set · 1 week · 1 session');
  assert.equal(readLine({ sets: 0, sessions: 0, weeks: 0 }), 'read nothing from your log');
  assert.equal(readLine({ sets: '12', sessions: 3, weeks: 1 }), null);
  assert.equal(readLine({ sets: 12, weeks: 1 }), null);
  assert.equal(readLine(null), null);
});

test('tool descriptions are ordered, deduplicated and bounded to known facts', () => {
  assert.equal(stepsLine([
    { tool: 'list_notes' }, { tool: 'list_notes' }, { tool: 'list_exercises', failed: true }, { tool: 'create_routine' },
  ]), 'It read your notes, then read your movement list (nothing came back), then created a routine.');
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
