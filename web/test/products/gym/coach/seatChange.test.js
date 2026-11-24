import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('../../../jsxLoader.mjs', import.meta.url);

const { GymProduct } = await import('../../../../../packages/api-contract/sync/reference/gym/product.js');
const { registry } = await import('../../../../src/platform/sync/schema.js');
const { AiClient } = await import('../../../../src/platform/ai/client.js');
const { CoachMessage } = await import('../../../../src/products/gym/domain/coach/conversation.js');
const { DeleteConversation, Mark, PictureCopy } = await import('../../../../src/products/gym/domain/coach/turn.js');
const { CoachTurns, coachRowsToForget, coachSeatWillChange, shareDoor } = await import('../../../../src/products/gym/coach/coachTurns.js');
const { GymProfile } = await import('../../../../src/products/gym/coach/profile.js');
const { forgetRetiredCoach } = await import('../../../../src/products/gym/coach/retiredCoach.js');
const { GymTurn, GymTurnHost } = await import('../../../../src/products/gym/coach/turnHost.js');
const { HostUnavailable } = await import('../../../../src/platform/agent/turn.js');
const { Decision } = await import('../../../../src/platform/domain-kit/actions.js');
const { FixedZone } = await import('../../../../src/platform/domain-kit/time.js');
const { GymRefusals } = await import('../../../../src/products/gym/domain/gymRules.js');
const { GymTurnTelemetry } = await import('../../../../src/products/gym/coach/turnTelemetry.js');
const { gymRoutes } = await import('../../../../src/products/gym/routes.js');
const { Harness } = await import('../../../platform/domain-kit/harness.js');
const { reidentify } = await import('../../../../../packages/api-contract/sync/reference/client/lifecycle.js');

const allowance = (code, remaining) => ({ tier: 'free', period: 'calendar_month_utc', limit: '1', used: '0', reserved: '0', remaining,
  resetsAt: 1790000000000, budgetResetsAt: null, code, capabilities: { text: { large: 'large', medium: 'medium', small: 'small' }, transcription: false } });
const ended = (stop, parts) => ({ id: 9, event: 'ended', data: { stop, message: { role: 'assistant', parts, carry: 'c' }, charged: '0', allowance: null } });
const quietTimers = { setInterval: () => null, clearInterval() {}, setTimeout, clearTimeout };

function runtime(withLock = (id, options, body) => body(true)) {
  let serial = 0;
  return { now: () => 0, newId: () => `call${String(++serial).padStart(18, '0')}`, withLock };
}

async function phone(t) {
  const harness = await Harness.open({ registry, product: new GymProduct(), scope: CoachMessage.scope });
  t.after(() => harness.close());
  return harness;
}

function coach(engine, ai, options = {}) {
  const told = { events: [], reports: [] };
  const profile = new GymProfile();
  const turns = new CoachTurns({ engine, ai, runtime: runtime(), profile, online: () => true, now: () => 0, textEvery: 0, timers: quietTimers,
    telemetry: new GymTurnTelemetry({ catalog: profile.catalog, event: (name, props) => told.events.push([name, props]), report: (...args) => told.reports.push(args) }),
    ...options });
  return { turns, told };
}

const settle = async (turns) => { while (turns.running) await turns.running.done; };
const outcomes = (told) => told.events.filter(([name]) => name.startsWith('gym_ask')).map(([name, props]) => (props.outcome ? `${name}:${props.outcome}` : name));

// The shell's sign-out on this page, as AuthProvider runs it: the products' begin, the engine's, the rows the finish takes.
async function signOut(harness, choice = 'keep') {
  await gymRoutes.sync.signOutBegins(harness.engine);
  harness.engine.online = false;
  await harness.engine.beginSignOut();
  const forget = await gymRoutes.sync.signOutForgets(harness.engine);
  return harness.engine.finishSignOut({ choice, forgetDeviceRows: forget ? { gym: forget } : {} });
}

test('R358-1, R7: a seat change after a text-only turn drops the pass and the allowance, and Coach asks the next seat afresh', async (t) => {
  const harness = await phone(t);
  let account = 'X';
  const passes = [];
  const transport = {
    pass: async () => { passes.push(account); return { status: 200, body: { pass: `pass-of-${account}`, expiresIn: 600_000 } }; },
    request: async ({ pass }) => ({ status: 200, body: pass === 'pass-of-X' ? allowance('subject_exhausted', '0') : allowance('ok', '1') }),
  };
  const ai = new AiClient({ transport, telemetry: { failure() {} }, now: () => 0 });
  const { turns } = coach(harness.engine, ai);
  turns.start();
  while (!turns.getSnapshot().allowance) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(turns.getSnapshot().refusal.state, 'allowance');
  const seat = turns.getSnapshot().seat;

  assert.equal((await signOut(harness)).complete, true);
  account = 'Y';
  assert.notEqual(turns.getSnapshot().seat, seat, 'the page\'s Coach heard the seat change');
  assert.deepEqual([turns.getSnapshot().refusal, turns.getSnapshot().allowance, turns.started], [null, null, false]);
  turns.start();
  while (!turns.getSnapshot().allowance) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(passes, ['X', 'Y'], 'the next seat asks the pass door anew');
  assert.equal(turns.getSnapshot().allowance.code, 'ok');
});

test('R3, R5: the field\'s words and a question taken back with its picture leave with the seat', async (t) => {
  const harness = await phone(t);
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }),
    text: async () => ({ failure: { source: 'pass', code: null, admission: 'none', allowance: null } }) };
  const { turns } = coach(harness.engine, ai);
  const model = new PictureCopy('image/jpeg', 2, 2, 'AAAA');
  await turns.send({ question: 'my private question', picture: { original: model, model } });
  await settle(turns);
  assert.equal(turns.getSnapshot().withdrawn.question, 'my private question');
  turns.setDraft('my private unsent words');
  assert.equal((await signOut(harness)).complete, true);
  const after = turns.getSnapshot();
  assert.deepEqual([after.draft, after.withdrawn, after.refusal, turns.drafts.size], ['', null, null, 0]);
});

// navigator.locks as one browser holds them across its tabs: exclusive, with ifAvailable.
function sharedLocks() {
  const held = new Set();
  const queues = new Map();
  return {
    async request(name, { ifAvailable }, body) {
      if (held.has(name)) {
        if (ifAvailable) return body(false);
        await new Promise((resolve) => { const queue = queues.get(name) ?? []; queue.push(resolve); queues.set(name, queue); });
      }
      held.add(name);
      try { return await body(true); }
      finally { held.delete(name); queues.get(name)?.shift()?.(); }
    },
  };
}

test('R358-2: a second tab whose Coach starts as the first tab sends never ends that fresh turn', async (t) => {
  const harness = await phone(t);
  const locks = sharedLocks();
  const tab = () => runtime((id, { ifAvailable }, body) => locks.request(`coach:${id}`, { ifAvailable }, (lock) => body(lock)));
  const asked = [];
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }),
    text: async ({ onText }) => { asked.push(1); await onText('Hi.'); return ended('completed', [{ text: 'Hi.' }]); } };
  const tabA = coach(harness.engine, ai, { runtime: tab() }).turns;
  const tabB = coach(harness.engine, ai, { runtime: tab() }).turns;
  // Tab B's room opens in the moment between tab A's open landing in the store and tab A taking the turn's lock.
  const commit = harness.engine.commit.bind(harness.engine);
  let fired = false;
  harness.engine.commit = async (...args) => {
    const answer = await commit(...args);
    const marked = harness.runner.read(CoachMessage.scope, (read) => Mark.read(read).turnId);
    if (!fired && marked !== null) { fired = true; tabB.start(); }
    return answer;
  };
  const turn = await tabA.send({ question: 'Plan my week.' });
  assert.ok(turn);
  while (tabA.running || tabB.running) await (tabA.running ?? tabB.running).done;
  const message = harness.drawn(CoachMessage).find((each) => each.id.equals(turn.coach));
  assert.deepEqual([message.state, message.text, asked.length], ['completed', 'Hi.', 1]);
});

test('R358-3: a sign-out the person cancels keeps the only copy of every picture they sent Coach', async (t) => {
  const harness = await phone(t);
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }), text: async () => ended('completed', [{ text: 'A rack.' }]) };
  const { turns } = coach(harness.engine, ai);
  const copy = new PictureCopy('image/jpeg', 2, 2, 'AAAA');
  const turn = await turns.send({ question: 'What is this?', picture: { original: copy, model: copy } });
  await settle(turns);
  await harness.sync();
  const key = `picture:${harness.drawn(CoachMessage).find((message) => message.id.equals(turn.lifter)).pictures[0].id}`;
  await coachSeatWillChange(harness.engine);
  harness.engine.online = false;
  await harness.engine.beginSignOut();
  assert.deepEqual(coachRowsToForget(harness.engine), [key], 'the finish would take it');
  await harness.engine.cancelSignOut();
  assert.equal(harness.engine.device.activeReplica.meta.state, 'bound', 'still signed in');
  assert.ok(harness.runner.read(CoachMessage.scope, (read) => read.device(key)), 'the picture stays');
});

test('R1, O2: a send cut off by a sign-out ends in one outcome, interrupted', async (t) => {
  const harness = await phone(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }),
    text: async ({ onText }) => { await onText('Half'); await held; return ended('completed', [{ text: 'Half' }]); } };
  const { turns, told } = coach(harness.engine, ai);
  const turn = await turns.send({ question: 'Explain deloads.' });
  while (harness.drawn(CoachMessage).find((message) => message.id.equals(turn.coach))?.text !== 'Half') await new Promise((resolve) => setTimeout(resolve, 5));
  await turns.seatWillChange();
  release();
  await settle(turns);
  assert.deepEqual(outcomes(told), ['gym_ask_started', 'gym_ask_outcome:interrupted']);
  assert.deepEqual(told.reports, []);
});

test('R2, O1: a send whose conversation is deleted under it ends in one outcome, gone', async (t) => {
  const harness = await phone(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }),
    text: async ({ onText }) => { await onText('Half'); await held; await onText(' more'); return ended('completed', [{ text: 'Half more' }]); } };
  const { turns, told } = coach(harness.engine, ai);
  const turn = await turns.send({ question: 'Explain deloads.' });
  while (harness.drawn(CoachMessage).find((message) => message.id.equals(turn.coach))?.text !== 'Half') await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await harness.runner.run(new DeleteConversation(turn.thread))).kind, 'committed');
  release();
  await settle(turns);
  assert.deepEqual(outcomes(told), ['gym_ask_started', 'gym_ask_outcome:gone']);
  assert.deepEqual(told.reports, []);
});

test('R4, O3: a recovered turn that breaks tells no outcome of a send it never started', async (t) => {
  const harness = await phone(t);
  const { turns, told } = coach(harness.engine, { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }) });
  turns.runner.run = async () => { throw new Error('boom'); };
  turns.launch({ lease: new GymTurn({ thread: null, lifter: null, coach: { record: 'x' } }, turns.binding), question: '', picture: null }, true);
  await settle(turns);
  assert.deepEqual(outcomes(told), []);
});

test('R6, O5: a report carries frames, never the error\'s words, and names only an error kind it knows', () => {
  const reports = [];
  const telemetry = new GymTurnTelemetry({ catalog: new GymProfile().catalog, event() {}, report: (...args) => reports.push(args) });
  const error = new Error('SECRET question text\nsecond line SECRET');
  const odd = Object.assign(new Error('SECRET'), { name: 'SECRET kind' });
  telemetry.failure('agent-host', error);
  telemetry.fault('storage', odd);
  assert.equal(JSON.stringify(reports).includes('SECRET'), false);
  assert.deepEqual(reports.map(([kind, operation, , route, tags]) => [kind, operation, route, tags]),
    [['Error', 'agent-host', '/app/gym', { operation: 'agent-host' }], ['other', 'gym-coach-turn', '/app/gym', { failure_kind: 'storage' }]]);
});

test('O4: the AI client hands its reporter the error it caught', async () => {
  const failures = [];
  const thrown = new Error('broken pass door wiring');
  const client = new AiClient({ telemetry: { failure: (operation, error) => failures.push([operation, error]) }, transport: { pass: async () => { throw thrown; } } });
  await client.credential('gym.coach', 1, 0);
  assert.deepEqual(failures, [['ai-pass', thrown]]);
});

test('F4: the retired Coach\'s storage is deleted, and nothing else', () => {
  const kept = new Map([['windmill.gym.coach.alice.current', 'a question'], ['windmill.gym.coach.alice.thr_1', 'an answer'], ['windmill.theme', 'dark']]);
  const storage = { get length() { return kept.size; }, key: (index) => [...kept.keys()][index] ?? null, removeItem: (key) => kept.delete(key) };
  const deleted = [];
  forgetRetiredCoach({ storage, databases: { deleteDatabase: (name) => deleted.push(name) } });
  assert.deepEqual([[...kept.keys()], deleted], [['windmill.theme'], ['windmill.gym.coach.photos']]);
  forgetRetiredCoach({ storage: { get length() { throw new Error('denied'); } }, databases: null });
});

test('F5: deleting a conversation is told, and one answering here stays, told as answering', async (t) => {
  const harness = await phone(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const ai = { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }), text: async () => { await held; return ended('completed', [{ text: 'Hi.' }]); } };
  const { turns, told } = coach(harness.engine, ai);
  const turn = await turns.send({ question: 'Hello?' });
  await assert.rejects(turns.deleteConversation(turn.thread));
  release();
  await settle(turns);
  await turns.deleteConversation(turn.thread);
  assert.deepEqual(harness.drawn(CoachMessage), []);
  assert.deepEqual(told.events.filter(([name]) => name === 'coach_conversation_delete').map(([, props]) => props.outcome), ['answering', 'deleted']);
});

test('the Share door that never answers lets the turn go on as refused, within its bound', async () => {
  const door = shareDoor({ shareSession: () => new Promise(() => {}) }, 'https://windmill.works', globalThis, 10);
  await assert.rejects(door.share('session-1'), (error) => error.name === 'TimeoutError');
});

test('a re-identify keeps Coach\'s seat, which is the binding: the field\'s words stay, and the seat\'s writes land', async (t) => {
  const harness = await phone(t);
  const { engine } = harness;
  const { turns } = coach(engine, { connected: () => true, clearPass() {}, allowance: async () => ({ failure: {} }) });
  turns.setDraft('half a question');
  const before = { seat: turns.getSnapshot().seat, replica: engine.activeReplica() };
  await engine.write(null, (device, ctx) => reidentify(device.activeReplica, ctx));
  const landed = await turns.host.runnerOn(before.seat).run({ scope: CoachMessage.scope, refusals: GymRefusals, load: () => null,
    decide: () => Decision.unchanged(null) }).then(() => 'landed', (error) => (error instanceof HostUnavailable ? `unavailable:${error.reason}` : error.name));
  assert.deepEqual({ reidentified: engine.activeReplica() !== before.replica, seat: turns.getSnapshot().seat === before.seat, draft: turns.draft(), landed },
    { reidentified: true, seat: true, draft: 'half a question', landed: 'landed' });
});

test('a turn\'s write the engine held while the seat moved ends the turn as the seat\'s, never as a fault of the host', async (t) => {
  const harness = await phone(t);
  const { engine } = harness;
  const host = new GymTurnHost({ engine, zone: new FixedZone(0) });
  const write = engine.write.bind(engine);
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  t.mock.method(engine, 'write', async (operation, ...rest) => {
    if (operation === 'sync-commit') await slow;
    return write(operation, ...rest);
  });
  const held = host.runnerOn(engine.activeBinding()).run({ scope: CoachMessage.scope, refusals: GymRefusals, load: () => null,
    decide: () => Decision.unchanged(null) }).then(() => 'landed', (error) => (error instanceof HostUnavailable ? `unavailable:${error.reason}` : error.name));
  assert.equal((await signOut(harness)).complete, true);
  release();
  assert.equal(await held, 'unavailable:seat');
});
