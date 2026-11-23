import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../../../jsxLoader.mjs', import.meta.url);

const { Reader, Views } = await import('../../../../src/platform/domain-kit/reading.js');
const { registry } = await import('../../../../src/platform/sync/schema.js');
const { Instant, Moment } = await import('../../../../src/platform/domain-kit/time.js');
const { viewRecords } = await import('../../../platform/domain-kit/vectors.js');
const { conversationView, historyRows } = await import('../../../../src/products/gym/coach/conversations.js');

const stamp = 'h1';
const row = (t, id, fields) => ({ t, id, seq: 1, life: ['alive', stamp], f: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, [value, stamp]])) });
const replica = `rp_${'0'.repeat(32)}`;
const zone = { offsetSeconds: () => 0 };
const reader = (rows) => new Reader(Views.ofRecords(registry, { drawn: viewRecords(rows), stored: viewRecords(rows) }), 'self/gym', new Moment(new Instant(1_800_000_000_000), zone));
const call = (name, created = []) => ({ callId: `call-${name}`, name, outcome: 'ok', created, read: { sessions: [], sets: [], weeks: [] } });

// A conversation a phone held: its picture kept on the phone, a routine it created, and a workout proposal it made.
const records = [
  row('thread', 'thread0001', { title: 'Shoulder feels off on bench. What should I change today?' }),
  row('message', 'lifter0001', { threadId: 'thread0001', role: 'lifter', at: 1_799_999_000_000, text: 'Shoulder feels off on bench. What should I change today?',
    pictures: [{ id: 'picture0001', mediaType: 'image/jpeg', localOnly: true }] }),
  row('message', 'coach00001', { threadId: 'thread0001', role: 'coach', at: 1_799_999_000_000, replica, text: 'Bench stays as logged.', state: 'completed',
    truncated: false, receipt: { read: { sets: 0, sessions: 1, weeks: 6 }, results: [] },
    calls: [call('get_session'), call('create_routine', [{ t: 'routine', id: 'routine001' }]), call('propose_workout_change', [{ t: 'workoutProposal', id: 'workout001' }])] }),
  row('routine', 'routine001', { name: 'Upper A', position: 1, entries: [{ exerciseId: 'bench-press' }, { exerciseId: 'barbell-row' }] }),
  row('workoutProposal', 'workout001', { sessionId: 'session001', summary: 'Lighter today', changes: [], door: 'ask', connection: '', agent: '', changeCount: 1 }),
];

test('a phone\'s conversation reads here whole: its picture held there, the routine it made, and its workout proposal as a row', () => {
  const view = conversationView(reader(records), 'thread0001', null);
  assert.deepEqual(view.messages.map((message) => message.role), ['lifter', 'coach']);
  assert.deepEqual(view.messages[0].pictures, [{ id: 'picture0001', copy: null }]);
  const answer = view.messages[1];
  assert.deepEqual([answer.answering, answer.read, answer.routines, answer.proposals, answer.workoutProposals], [null,
    { sets: 0, sessions: 1, weeks: 6, totalsOnly: false, thisWorkout: false }, [{ id: 'routine001', name: 'Upper A', movements: 2 }], [], [{ id: 'workout001', changes: 1 }]]);
});

test('History names what a conversation\'s last turn made, newest first, and a running turn of another device answers elsewhere', () => {
  assert.deepEqual(historyRows(reader(records)), [{ id: 'thread0001', title: 'Shoulder feels off on bench. What should I change today?',
    at: 1_799_999_000_000, line: { kind: 'created', count: 1 } }]);
  const running = records.map((each) => (each.id === 'coach00001' ? row('message', 'coach00001', { threadId: 'thread0001', role: 'coach',
    at: 1_799_999_000_000, replica, text: '', state: 'running', truncated: false, calls: [] }) : each));
  assert.equal(conversationView(reader(running), 'thread0001', null).messages[1].answering, 'elsewhere');
  assert.equal(historyRows(reader(running))[0].line, null);
});

test('an answer whose one workout read is the workout open at its opening says it read this workout', () => {
  const opened = records.map((each) => (each.id === 'coach00001' ? row('message', 'coach00001', { threadId: 'thread0001', role: 'coach',
    at: 1_799_999_000_000, replica, text: 'Bench stays as logged.', state: 'completed', truncated: false,
    receipt: { read: { sets: 4, sessions: 1, weeks: 6 }, results: [] }, calls: [{ ...call('get_session'), callId: 'context-get_session' }] }) : each));
  assert.equal(conversationView(reader(opened), 'thread0001', null).messages[1].read.thisWorkout, true);
});
