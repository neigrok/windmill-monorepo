import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../../../jsxLoader.mjs', import.meta.url);

const { GymProduct } = await import('../../../../../packages/api-contract/sync/reference/gym/product.js');
const { Id } = await import('../../../../src/platform/domain-kit/entities.js');
const { registry } = await import('../../../../src/platform/sync/schema.js');
const { CoachMessage, CoachThread } = await import('../../../../src/products/gym/domain/coach/conversation.js');
const { BeginRound, Mark, OpenTurn, PictureCopy, StreamTurnText } = await import('../../../../src/products/gym/domain/coach/turn.js');
const { Routine } = await import('../../../../src/products/gym/domain/routines.js');
const { CoachTurns } = await import('../../../../src/products/gym/coach/coachTurns.js');
const { GymProfile } = await import('../../../../src/products/gym/coach/profile.js');
const { GymTurnTelemetry } = await import('../../../../src/products/gym/coach/turnTelemetry.js');
const { Harness } = await import('../../../platform/domain-kit/harness.js');

const ok = { tier: 'free', period: 'calendar_month_utc', limit: '1', used: '0', reserved: '0', remaining: '1', resetsAt: null, budgetResetsAt: null,
  code: 'ok', capabilities: { text: { large: 'large', medium: 'medium', small: 'small' }, transcription: false } };
const ended = (stop, parts) => ({ id: 9, event: 'ended', data: { stop, message: { role: 'assistant', parts, carry: 'c' }, charged: '0', allowance: null } });

// A played AI service: each round answers the next of `rounds`, a function of the request that may stream text first.
function playedAi(rounds, { result = null, allowance = ok } = {}) {
  const requests = [];
  return {
    requests,
    connected: () => true,
    clearPass() {},
    allowance: async () => allowance,
    text: async (options) => {
      requests.push(options);
      const round = rounds.shift();
      if (!round) throw new Error('no round left to play');
      return round(options);
    },
    result: async (options) => result(options),
  };
}

function runtime() {
  let serial = 0;
  return { now: () => 0, newId: () => `call${String(++serial).padStart(18, '0')}`, withLock: (id, options, body) => body(true) };
}

async function room(t, ai, options = {}) {
  const phone = await Harness.open({ registry, product: new GymProduct(), scope: CoachMessage.scope });
  t.after(() => phone.close());
  const told = { events: [], reports: [] };
  const profile = new GymProfile();
  const turns = new CoachTurns({ engine: phone.engine, ai, runtime: runtime(), profile, appBaseUrl: 'https://windmill.works', online: () => true,
    now: () => 0, textEvery: 0,
    telemetry: new GymTurnTelemetry({ catalog: profile.catalog, event: (name, props) => told.events.push([name, props]), report: (...args) => told.reports.push(args) }),
    ...options });
  return { phone, turns, told };
}

const messages = (phone) => phone.drawn(CoachMessage);
const coachOf = (phone, turn) => messages(phone).find((message) => message.id.equals(turn.coach));
const settle = async (turns) => { while (turns.running) await turns.running.done; };

test('a question is answered in the browser: the context reads and the answer land on the Coach message, and the turn tells its end', async (t) => {
  const ai = playedAi([async ({ onText }) => { await onText('Add '); await onText('5 kg.'); return ended('completed', [{ text: 'Add 5 kg.' }]); }]);
  const { phone, turns, told } = await room(t, ai);
  const turn = await turns.send({ question: 'How heavy today?' });
  assert.ok(turn);
  await settle(turns);
  const coach = coachOf(phone, turn);
  assert.deepEqual([coach.state, coach.text, coach.truncated], ['completed', 'Add 5 kg.', false]);
  assert.deepEqual(coach.calls.map((call) => [call.callId, call.outcome]),
    [['context-list_sessions', 'ok'], ['context-list_notes', 'ok'], ['context-list_exercises', 'ok'], ['context-list_routines', 'ok']]);
  const request = ai.requests[0].request;
  assert.equal(request.system[0], turns.profile.words.prompt);
  assert.ok(!request.tools.some((tool) => tool.name === 'propose_workout_change'));
  assert.deepEqual(request.tools.filter((tool) => tool.strict).map((tool) => tool.name).sort(),
    ['create_exercise', 'create_routine', 'propose_routine_change', 'propose_routine_removal']);
  assert.equal(request.messages[0].parts.at(-1).text, 'How heavy today?');
  assert.equal(phone.runner.read(CoachMessage.scope, (read) => read.device(Mark.turnKey)), null);
  assert.deepEqual(told.events.map(([name]) => name).filter((name) => name !== 'coach_ability'), ['gym_ask_started', 'coach_turn', 'gym_ask_outcome']);
  assert.deepEqual(told.events.find(([name]) => name === 'coach_turn')[1],
    { state: 'completed', seat: 'bound', rounds: 1, ability_calls: 0, refusals: 0, answer_bytes: 9, duration_ms: 0 });
  assert.deepEqual(told.events.at(-1), ['gym_ask_outcome', { screen: 'coach', outcome: 'answered', duration_ms: 0 }]);
  assert.deepEqual(told.reports, []);
});

test('an ability that writes creates the routine at once, under the id its turn seeds, recorded on the Coach message', async (t) => {
  const input = { entries: [{ exerciseId: 'bench-press', sets: [{ reps: 5, weightKg: 60 }] }], id: 'the-model-names-this', name: 'Push A', position: 1 };
  const ai = playedAi([
    async () => ended('tool_calls', [{ toolCall: { id: 'toolu_1', name: 'create_routine', input } }]),
    async ({ request }) => {
      assert.equal(request.messages.at(-1).role, 'tool');
      assert.equal(request.messages.at(-1).results[0].isError, false);
      return ended('completed', [{ text: 'Made Push A.' }]);
    },
  ]);
  const { phone, turns } = await room(t, ai);
  const turn = await turns.send({ question: 'Make me a push day.' });
  await settle(turns);
  const coach = coachOf(phone, turn);
  const created = coach.calls.find((call) => call.name === 'create_routine');
  assert.equal(created.outcome, 'ok');
  const routine = phone.drawn(Routine).find((each) => each.id.equals(new Id(created.created[0].id, Routine)));
  assert.equal(routine?.name, 'Push A');
  assert.notEqual(routine.id.record, 'the-model-names-this');
  assert.deepEqual(coach.receipt.results, [{ t: 'routine', id: routine.id.record }]);
});

test('a question sent with no connection writes nothing and stays in the field', async (t) => {
  const { phone, turns, told } = await room(t, playedAi([]), { online: () => false });
  assert.equal(await turns.send({ question: 'Still there?' }), null);
  assert.deepEqual(turns.getSnapshot().refusal, { state: 'offline' });
  assert.deepEqual(messages(phone), []);
  assert.deepEqual(told.events, [['gym_ask_outcome', { screen: 'coach', outcome: 'offline' }]]);
});

test('a turn the pass door refused before any call is withdrawn, its question back in the field, and a door that answered is never offline', async (t) => {
  for (const [failure, state] of [[{ source: 'pass', code: null, admission: 'none', allowance: null }, 'did-not-answer'],
    [{ source: 'transport', code: null, admission: 'none', allowance: null }, 'offline'],
    [{ source: 'text', code: 'subject_exhausted', admission: 'none', allowance: { ...ok, code: 'subject_exhausted', remaining: '0', resetsAt: 1790000000000 } }, 'allowance']]) {
    const { phone, turns } = await room(t, playedAi([async () => ({ failure })]));
    const turn = await turns.send({ question: 'Plan my week.' });
    await settle(turns);
    assert.deepEqual(messages(phone), []);
    assert.equal(phone.drawn(CoachThread).find((each) => each.id.equals(turn.thread)), undefined);
    assert.equal(turns.getSnapshot().refusal.state, state);
    assert.equal(turns.getSnapshot().withdrawn.question, 'Plan my week.');
  }
});

test('a host failure before the engine holds the turn takes the turn back, says so, and reports once with its own error', async (t) => {
  const fault = new Error('context words unreadable');
  class Broken extends GymProfile { context() { throw fault; } }
  const { phone, turns, told } = await room(t, playedAi([]), { profile: new Broken() });
  await turns.send({ question: 'Hello?' });
  await settle(turns);
  assert.deepEqual(messages(phone), []);
  assert.equal(turns.getSnapshot().fault, 'no-answer');
  assert.equal(turns.getSnapshot().withdrawn.question, 'Hello?');
  assert.deepEqual(told.reports.map(([kind, operation, , , tags]) => [kind, operation, tags]), [['Error', 'agent-host', { operation: 'agent-host' }]]);
  assert.ok(!told.reports[0][2].includes('context words unreadable'));
});

test('a sign-out while the answer streams ends the turn interrupted with its words, clears the mark, and writes nothing after', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const ai = playedAi([async ({ onText }) => { await onText('Half an ans'); await held; await onText('wer'); return ended('completed', [{ text: 'Half an answer' }]); }]);
  const { phone, turns } = await room(t, ai);
  const turn = await turns.send({ question: 'Explain deloads.' });
  while (coachOf(phone, turn)?.text !== 'Half an ans') await new Promise((resolve) => setTimeout(resolve, 5));
  await turns.seatWillChange();
  assert.deepEqual([coachOf(phone, turn).state, coachOf(phone, turn).text], ['interrupted', 'Half an ans']);
  assert.equal(phone.runner.read(CoachMessage.scope, (read) => read.device(Mark.turnKey)), null);
  release();
  await settle(turns);
  assert.deepEqual([coachOf(phone, turn).state, coachOf(phone, turn).text], ['interrupted', 'Half an ans']);
});

test('a share runs through the Share door and its result is recorded as any call', async (t) => {
  const shared = [];
  const shares = { share: async (sessionId) => { shared.push(sessionId); return { url: 'https://windmill.works/#/gym/shared/tok', token: 'tok', expiresAt: 5 }; },
    revoke: async () => { throw Object.assign(new Error('no share'), { status: 404 }); } };
  const ai = playedAi([
    async () => ended('tool_calls', [{ toolCall: { id: 'toolu_1', name: 'share_session', input: { sessionId: 'session-1' } } },
      { toolCall: { id: 'toolu_2', name: 'revoke_share', input: { sessionId: 'session-2' } } }]),
    async ({ request }) => {
      assert.deepEqual(request.messages.at(-1).results.map((each) => [each.isError, each.content]),
        [[false, '{"expiresAt":5,"token":"tok","url":"https://windmill.works/#/gym/shared/tok"}'], [true, '{"code":"refused","message":""}']]);
      return ended('completed', [{ text: 'Shared.' }]);
    },
  ]);
  const { phone, turns, told } = await room(t, ai, { shares });
  const turn = await turns.send({ question: 'Share my last workout.' });
  await settle(turns);
  assert.deepEqual(shared, ['session-1']);
  assert.deepEqual(coachOf(phone, turn).calls.filter((call) => !call.callId.startsWith('context-')).map((call) => [call.name, call.outcome]),
    [['share_session', 'ok'], ['revoke_share', 'refused']]);
  assert.deepEqual(told.reports, []);
});

test('a tab returning to a turn in its last round recovers its answer after the words that came before that round', async (t) => {
  const ai = playedAi([], { result: async ({ callId, onText }) => {
    assert.equal(callId, 'call000000000000000009');
    await onText(' Then rest.');
    return ended('completed', [{ text: 'Then rest.' }]);
  } });
  const { phone, turns } = await room(t, ai);
  const opened = await phone.runner.run(new OpenTurn({ question: 'What next?' }));
  const turn = opened.result;
  await phone.runner.run(new StreamTurnText(turn.coach, 'Squat first.'));
  await phone.runner.run(new BeginRound(turn.coach, 'call000000000000000009', 12));
  await phone.runner.run(new StreamTurnText(turn.coach, 'Squat first. The'));
  turns.start();
  while (!turns.running) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle(turns);
  assert.deepEqual([coachOf(phone, turn).state, coachOf(phone, turn).text], ['completed', 'Squat first. Then rest.']);
});

test('one gym turn runs at a time across a browser\'s tabs: a second tab is refused busy while the first answers', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { phone, turns } = await room(t, playedAi([async () => { await held; return ended('completed', [{ text: 'Done.' }]); }]));
  const other = new CoachTurns({ engine: phone.engine, ai: playedAi([]), runtime: runtime(), online: () => true, now: () => 0,
    telemetry: new GymTurnTelemetry({ catalog: turns.catalog, event() {}, report() {} }) });
  await turns.send({ question: 'First?' });
  assert.equal(await other.send({ question: 'Second?' }), null);
  assert.deepEqual(other.getSnapshot().refusal, { state: 'busy' });
  release();
  await settle(turns);
  assert.equal(messages(phone).length, 2);
});

test('a picture is kept in the browser, named localOnly on the question, and its model copy uploaded once for the turn', async (t) => {
  const model = new PictureCopy('image/jpeg', 2, 2, 'AAAA');
  const ai = playedAi([async ({ pictures, request }) => {
    assert.deepEqual(pictures.map((picture) => [picture.mediaType, [...picture.bytes]]), [['image/jpeg', [0, 0, 0]]]);
    assert.deepEqual(request.messages[0].parts.filter((part) => part.image).map((part) => part.image.picture), [pictures[0].pictureId]);
    assert.equal(request.messages[0].parts.at(-1).text, 'Please help me with this photo.');
    return ended('completed', [{ text: 'A squat rack.' }]);
  }]);
  const { phone, turns } = await room(t, ai);
  const turn = await turns.send({ question: '', picture: { original: model, model } });
  await settle(turns);
  const lifter = messages(phone).find((message) => message.id.equals(turn.lifter));
  assert.equal(lifter.pictures.length, 1);
  assert.equal(lifter.pictures[0].localOnly, true);
  assert.ok(phone.runner.read(CoachMessage.scope, (read) => read.device(`picture:${lifter.pictures[0].id}`)));
});
