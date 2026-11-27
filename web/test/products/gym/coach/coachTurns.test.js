import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../../../jsxLoader.mjs', import.meta.url);

const { GymProduct } = await import('../../../../../packages/api-contract/sync/reference/gym/product.js');
const { Id } = await import('../../../../src/platform/domain-kit/entities.js');
const { registry } = await import('../../../../src/platform/sync/schema.js');
const { CoachMessage, CoachThread } = await import('../../../../src/products/gym/domain/coach/conversation.js');
const { BeginRound, Mark, OpenTurn, PictureCopy, StreamTurnText } = await import('../../../../src/products/gym/domain/coach/turn.js');
const { Routine, RoutineEntry, RoutineValue, SetTarget } = await import('../../../../src/products/gym/domain/routines.js');
const { Draft } = await import('../../../../src/platform/domain-kit/drafts.js');
const { Instant } = await import('../../../../src/platform/domain-kit/time.js');
const { Exercise } = await import('../../../../src/products/gym/domain/catalogue.js');
const { GymRefusals } = await import('../../../../src/products/gym/domain/gymRules.js');
const { Session, TrainingSet, TrainingSetValue } = await import('../../../../src/products/gym/domain/training.js');
const { AppendSet, FinishSession } = await import('../../../../src/products/gym/domain/trainingActions.js');
const { StartWorkout } = await import('../../../../src/products/gym/domain/workoutRack.js');
const { WorkoutProposal } = await import('../../../../src/products/gym/domain/workoutProposals.js');
const { conversationView } = await import('../../../../src/products/gym/coach/conversations.js');
const { createGymApi } = await import('../../../../src/products/gym/gymRuntime.js');
const { SeedExercises } = await import('../../../../src/products/gym/domain/seedExercises.js');
const { Proposal, ProposeRoutine } = await import('../../../../src/products/gym/domain/proposals.js');
const { BrowserSyncEngine } = await import('../../../../src/platform/sync/engine.js');
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
  assert.deepEqual(request.tools.filter((tool) => tool.strict).map((tool) => tool.name).sort(),
    ['create_exercise', 'create_routine', 'propose_routine_change', 'propose_routine_removal', 'propose_workout_change']);
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

// A workout open on the browser's copy: Upper A started, bench press then pull-ups, nothing logged.
async function workoutOpen(phone) {
  const upper = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [
    new RoutineEntry(new Id('dumbbell-bench-press', Exercise), [new SetTarget(8, 16), new SetTarget(8, 16)], 120),
    new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, 10), new SetTarget(8, 10)], 120)]);
  assert.equal((await phone.runner.save(Draft.new(upper), GymRefusals)).result.kind, 'saved');
  const session = new Id('session1', Session);
  assert.equal((await phone.runner.run(StartWorkout({ id: session, routineId: upper.id }))).kind, 'committed');
  return session;
}

test('Coach over an open workout proposes a change to it, the browser\'s copy applies it, and each decision is told once as the log answers it', async (t) => {
  const entries = [{ exerciseId: 'dumbbell-bench-press', restSeconds: 120, sets: [{ reps: 8, weightKg: 16 }, { reps: 8, weightKg: 16 }] },
    { exerciseId: 'pull-up', restSeconds: 120, sets: [{ reps: 8, weightKg: 0 }, { reps: 8, weightKg: 0 }] },
    { exerciseId: 'face-pull', sets: [{ reps: 15, weightKg: 15 }, { reps: 15, weightKg: 15 }] }];
  // Each question is answered in two rounds: the change to Upper A's open workout, then the words.
  const proposing = (proposed) => [
    async ({ request }) => {
      assert.ok(request.tools.some((tool) => tool.name === 'propose_workout_change'));
      return ended('tool_calls', [{ toolCall: { id: 'toolu_1', name: 'propose_workout_change',
        input: { id: 'the-model-names-this', sessionId: 'session1', entries: proposed, summary: 'Easy on the shoulder' } } }]);
    },
    async ({ request }) => {
      assert.equal(request.messages.at(-1).results[0].isError, false);
      return ended('completed', [{ text: 'Take the weight off pull-ups and add face pulls.' }]);
    },
  ];
  const rounds = proposing(entries);
  const { phone, turns } = await room(t, playedAi(rounds));
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const session = await workoutOpen(phone);
  await phone.sync();
  const turn = await turns.send({ question: 'My shoulder feels off on bench today.' });
  await settle(turns);
  const coach = coachOf(phone, turn);
  assert.ok(coach.calls.some((call) => call.callId === 'context-get_session' && call.outcome === 'ok'), 'the open workout is part of what Coach reads');
  const call = coach.calls.find((each) => each.name === 'propose_workout_change');
  assert.equal(call.outcome, 'ok');
  const id = String(call.created[0].id);
  const view = phone.runner.read(CoachMessage.scope, (read) => conversationView(read, turn.thread.record, null));
  assert.deepEqual(view.messages.at(-1).workoutProposals, [id]);
  await phone.sync();

  const failures = [];
  const told = [];
  const api = createGymApi(phone.engine, { event() {}, failure: (operation) => failures.push(operation), coached: (name, props) => told.push([name, props]) });
  const outcome = (action, answer) => ['gym_proposal_outcome', { screen: 'coach', target: 'workout', action, ...answer }];
  const answered = async () => { await phone.sync(); await new Promise((resolve) => setImmediate(resolve)); };
  await api.applyWorkoutProposal(id);
  const applied = phone.runner.read(Session.scope, (read) => ({ proposal: read.repository(WorkoutProposal).find(new Id(id, WorkoutProposal), 'drawn'),
    plan: read.repository(Session).find(session, 'drawn').plan.entries.map((entry) => entry.json) }));
  assert.equal(applied.proposal.state, 'applied');
  assert.deepEqual(applied.plan, entries);
  assert.deepEqual(told, [], 'nothing is told before the log answers');
  await answered();
  assert.deepEqual(told, [outcome('apply', { outcome: 'decided' })]);
  await api.applyWorkoutProposal(id);
  assert.deepEqual(told.at(-1), outcome('apply', { outcome: 'decided' }), 'an Apply that finds it applied writes nothing and is decided, as the iPhone tells it');

  // A second proposal; another device of the account logs a pull-up before this one hears of it, so the log refuses the Apply
  // this copy still took for current.
  rounds.push(...proposing(entries.map((entry) => (entry.exerciseId === 'pull-up' ? { ...entry, sets: [{ reps: 6, weightKg: 0 }, { reps: 6, weightKg: 0 }] } : entry))));
  const second = await turns.send({ question: 'Fewer pull-ups?', thread: turn.thread });
  await settle(turns);
  const later = String(coachOf(phone, second).calls.find((each) => each.name === 'propose_workout_change').created[0].id);
  await phone.sync();
  const other = await phone.device();
  t.after(() => other.close());
  await phone.sync();
  await phone.advance(60_000);
  const logged = new TrainingSetValue(new Id('setPullUp0000001', TrainingSet), session, new Id('pull-up', Exercise), 0, 8, new Instant(other.runner.moment().now.ms));
  assert.equal((await other.runner.run(AppendSet(logged))).kind, 'committed');
  assert.equal(await other.senderStep(), true, 'the log holds the other device\'s pull-up');
  told.length = 0;
  await api.applyWorkoutProposal(later);
  assert.deepEqual(told, []);
  await answered();
  assert.deepEqual(told, [outcome('apply', { outcome: 'failed', reason: 'workout-moved' })], 'the log refused it, with its reason');
  assert.equal(phone.runner.read(Session.scope, (read) => read.repository(WorkoutProposal).find(new Id(later, WorkoutProposal), 'drawn').state), 'pending');
  await api.applyWorkoutProposal(later);
  assert.deepEqual(told.at(-1), outcome('apply', { outcome: 'failed', reason: 'workout-moved' }), 'this copy now refuses it itself, for the same reason');
  assert.deepEqual(failures, [], 'out of date is a refusal, never a failure');

  // A store that breaks under a decision is a failure: it throws, is told failed, and goes to Sentry under its static name.
  const broken = new Error('the store broke');
  t.mock.method(phone.engine, 'commit', async () => { throw broken; });
  await assert.rejects(api.dismissWorkoutProposal(later), (error) => error === broken);
  assert.deepEqual([failures, told.at(-1)], [['workout-proposal-dismiss'], outcome('reject', { outcome: 'failed' })]);
});

test('a change to a workout another device finished before the change reached the log is told failed, the workout finished', async (t) => {
  const { phone, turns } = await room(t, playedAi([
    async () => ended('tool_calls', [{ toolCall: { id: 'toolu_1', name: 'propose_workout_change', input: { id: 'the-model-names-this', sessionId: 'session1',
      entries: [{ exerciseId: 'dumbbell-bench-press', restSeconds: 120, sets: [{ reps: 8, weightKg: 14 }, { reps: 8, weightKg: 14 }] },
        { exerciseId: 'pull-up', restSeconds: 120, sets: [{ reps: 8, weightKg: 10 }, { reps: 8, weightKg: 10 }] }], summary: '' } } }]),
    async () => ended('completed', [{ text: 'Lighter bench.' }]),
  ]));
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const session = await workoutOpen(phone);
  await phone.sync();
  const other = await phone.device();
  t.after(() => other.close());
  await phone.sync();
  await phone.advance(60_000);
  assert.equal((await other.runner.run(FinishSession({ id: session, finishedAt: new Instant(other.runner.moment().now.ms) }))).kind, 'committed');
  assert.equal(await other.senderStep(), true, 'the log holds the finish before this browser hears of it');
  const turn = await turns.send({ question: 'Lighter bench?' });
  await settle(turns);
  const id = String(coachOf(phone, turn).calls.find((call) => call.name === 'propose_workout_change').created[0].id);
  const told = [];
  const api = createGymApi(phone.engine, { event() {}, failure() {}, coached: (name, props) => told.push(props) });
  await api.applyWorkoutProposal(id);
  await phone.sync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(told, [{ screen: 'coach', target: 'workout', action: 'apply', outcome: 'failed', reason: 'workout-finished' }],
    'the log refused the change itself, and the Apply that named it folded into that refusal');
});

test('a routine\'s decision the log has not answered in 15 s is told stalled once and then decided as it answers, and another tab\'s Apply on it tells nothing', async (t) => {
  const { phone } = await room(t, playedAi([]));
  phone.server.product.seeds = Object.fromEntries(SeedExercises.all.map((seed) => [String(seed.id.record), seed.fields()]));
  const upper = new RoutineValue(new Id('routine1', Routine), 'Upper A', 0, [new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, 10)], 120)]);
  assert.equal((await phone.runner.save(Draft.new(upper), GymRefusals)).result.kind, 'saved');
  const proposal = new Id('proposal0000001', Proposal);
  assert.equal((await phone.runner.run(ProposeRoutine({ id: proposal, routineId: upper.id, name: 'Upper A', summary: '',
    entries: [new RoutineEntry(new Id('pull-up', Exercise), [new SetTarget(8, 10)], 120), new RoutineEntry(new Id('face-pull', Exercise), [new SetTarget(15, 15)])] }))).kind, 'committed');
  await phone.sync();
  const told = { one: [], two: [] };
  const second = await BrowserSyncEngine.open(phone.options);
  t.after(() => second.close());
  second.observe(Proposal.scope);
  const one = createGymApi(phone.engine, { event() {}, failure() {}, coached: (name, props) => told.one.push(props) });
  const two = createGymApi(second, { event() {}, failure() {}, coached: (name, props) => told.two.push(props) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await one.applyProposal(proposal.record);
  await second.refresh();
  await two.applyProposal(proposal.record);
  assert.deepEqual(told, { one: [], two: [] }, 'nothing is told before the log answers, and the second Apply writes nothing');
  t.mock.timers.tick(15_000);
  assert.deepEqual(told.one, [{ screen: 'coach', target: 'routine', action: 'apply', outcome: 'stalled' }]);
  t.mock.timers.reset();
  await phone.sync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(told, { one: [{ screen: 'coach', target: 'routine', action: 'apply', outcome: 'stalled' }, { screen: 'coach', target: 'routine', action: 'apply', outcome: 'decided' }],
    two: [] });
});

test('a refusal that answered one question stands no longer: one that fits is sent after one too long, and one asked while an answer runs is refused busy and sent once it ends', async (t) => {
  let finish;
  const answering = new Promise((resolve) => { finish = resolve; });
  const ai = playedAi([async () => { await answering; return ended('completed', [{ text: 'First.' }]); }, async () => ended('completed', [{ text: 'Second.' }])]);
  const { turns } = await room(t, ai);
  assert.equal(await turns.send({ question: 'x'.repeat(9_000) }), null);
  assert.deepEqual(turns.getSnapshot().refusal, { state: 'too-long' });
  const first = await turns.send({ question: 'How heavy today?' });
  assert.ok(first, 'a question that fits is sent');
  assert.equal(await turns.send({ question: 'And tomorrow?', thread: first.thread }), null);
  assert.deepEqual(turns.getSnapshot().refusal, { state: 'busy' });
  finish();
  await settle(turns);
  assert.equal(turns.getSnapshot().refusal, null, 'the answer ended, and busy with it');
  assert.ok(await turns.send({ question: 'And tomorrow?', thread: first.thread }));
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

test('a device whose sync is live ends another device\'s turn no write reached for thirty minutes, and one that is not ends none', async (t) => {
  const { phone, turns } = await room(t, playedAi([]));
  const other = await phone.device();
  const opened = await other.runner.run(new OpenTurn({ question: 'Left running?' }));
  await other.sync();
  const turn = opened.result;
  const changedAt = phone.runner.read(CoachMessage.scope, (read) => read.confirmed(CoachMessage, turn.coach)).ru;
  phone.engine.freshness = () => ({ syncLive: false, serverNow: changedAt + 1_800_000 });
  await turns.endStale();
  assert.equal(coachOf(phone, turn).state, 'running');
  phone.engine.freshness = () => ({ syncLive: true, serverNow: changedAt + 1_800_000 });
  await turns.endStale();
  assert.equal(coachOf(phone, turn).state, 'interrupted');
});
