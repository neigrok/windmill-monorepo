// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Catalog } from '../../../../../src/platform/domain-kit/abilities.js';
import { registry } from '../../../../../src/platform/sync/schema.js';
import { Note } from '../../../../../src/products/gym/domain/notes.js';
import { CoachMessage } from '../../../../../src/products/gym/domain/coach/conversation.js';
import { AbilityRequest, RecordShareCall, RunAbility } from '../../../../../src/products/gym/domain/coach/runAbility.js';
import { EndTurn, OpenTurn } from '../../../../../src/products/gym/domain/coach/turn.js';
import { Contract } from '../../../../platform/domain-kit/vectors.js';
import { Harness } from '../../../../platform/domain-kit/harness.js';

/** @typedef {import('../../../../../src/products/gym/domain/coach/turn.js').Turn} Turn */

const catalog = new Catalog(Contract.json('gym/catalog-3.json'));

/** @param {import('node:test').TestContext} t */
async function phones(t) {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: CoachMessage.scope });
  const b = await a.device();
  t.after(() => a.close());
  return { a, b };
}

/** @param {Harness} phone @returns {Promise<Turn>} */
async function open(phone) {
  const outcome = await phone.runner.run(new OpenTurn({ question: 'Remember this.' }));
  assert.equal(outcome.kind, 'committed');
  return /** @type {any} */ (outcome).result;
}

/** @param {Harness} phone @param {Turn} turn */
const coach = (phone, turn) => {
  const message = phone.drawn(CoachMessage).find((each) => each.id.equals(turn.coach));
  assert.ok(message);
  return message;
};

// The call as the model made it; the executor names its record from the turn (G-7).
/** @param {Harness} phone @param {Turn} turn @param {string} callId @param {string} name @param {any} input */
function call(phone, turn, callId, name, input) {
  return phone.runner.run(new RunAbility(new AbilityRequest(callId, name, input), turn.coach, 'bound', catalog, 'https://windmill.works'));
}

/** @param {any} outcome */
const answered = (outcome) => {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return outcome.result;
};

const note = (/** @type {string} */ title) => ({ id: 'the-model-names-this', title, body: 'Left knee.' });

test('a note Coach saves lands with its call in one write, under the id its turn seeds, and reaches the other device', async (t) => {
  const { a, b } = await phones(t);
  const turn = await open(a);
  const outcome = answered(await call(a, turn, 'call-1', 'save_note', note('Knee')));
  assert.equal(outcome.kind, 'result');
  const id = `${turn.coach.record}-1`;
  assert.deepEqual(a.drawn(Note).map((value) => value.id.record), [id]);
  assert.deepEqual(coach(a, turn).calls.map((each) => [each.callId, each.outcome, each.created]), [['call-1', 'ok', [{ t: 'note', id }]]]);
  await a.sync();
  assert.deepEqual(b.drawn(Note).map((value) => [value.id.record, value.title]), [[id, 'Knee']]);
  assert.deepEqual(coach(b, turn).calls.map((each) => each.callId), ['call-1']);
});

test('a call run again under its id seeds the same record and keeps one record of the call; the next call seeds the next', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  const first = answered(await call(a, turn, 'call-1', 'save_note', note('Knee')));
  const again = await call(a, turn, 'call-1', 'save_note', note('Knee'));
  assert.equal(again.kind, 'unchanged');
  assert.equal(/** @type {any} */ (again).result.sha256, first.sha256);
  answered(await call(a, turn, 'call-2', 'save_note', note('Shoulder')));
  assert.deepEqual(a.drawn(Note).map((value) => value.id.record), [`${turn.coach.record}-1`, `${turn.coach.record}-2`]);
  assert.deepEqual(coach(a, turn).calls.map((each) => each.callId), ['call-1', 'call-2']);
});

test('two calls of one round, made before either ran, take an ordinal each', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  const both = [new RunAbility(new AbilityRequest('call-1', 'save_note', note('Knee')), turn.coach, 'bound', catalog, ''),
    new RunAbility(new AbilityRequest('call-2', 'save_note', note('Shoulder')), turn.coach, 'bound', catalog, '')];
  for (const each of both) answered(await a.runner.run(each));
  assert.deepEqual(a.drawn(Note).map((value) => [value.id.record, value.title]), [[`${turn.coach.record}-1`, 'Knee'], [`${turn.coach.record}-2`, 'Shoulder']]);
});

test('a call its rule refused holds its ordinal, so running it again names no record a later call took', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  assert.deepEqual(answered(await call(a, turn, 'call-1', 'save_note', note(''))), { kind: 'refused', code: 'invalid-arguments' });
  answered(await call(a, turn, 'call-2', 'save_note', note('Shoulder')));
  assert.equal(answered(await call(a, turn, 'call-1', 'save_note', note('Knee'))).kind, 'result');
  assert.deepEqual(a.drawn(Note).map((value) => [value.id.record, value.title]).sort(), [[`${turn.coach.record}-1`, 'Knee'], [`${turn.coach.record}-2`, 'Shoulder']]);
  assert.deepEqual(coach(a, turn).calls.map((each) => [each.callId, each.outcome]), [['call-1', 'ok'], ['call-2', 'ok']]);
});

test('a call the gate refused holds no ordinal, and running it again takes the next one, last', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  assert.deepEqual(answered(await call(a, turn, 'call-1', 'save_note', { id: 'x', title: 'Knee' })), { kind: 'refused', code: 'invalid-input' });
  answered(await call(a, turn, 'call-2', 'save_note', note('Shoulder')));
  answered(await call(a, turn, 'call-1', 'save_note', note('Knee')));
  assert.deepEqual(a.drawn(Note).map((value) => [value.id.record, value.title]).sort(), [[`${turn.coach.record}-1`, 'Shoulder'], [`${turn.coach.record}-2`, 'Knee']]);
  assert.deepEqual(coach(a, turn).calls.map((each) => [each.callId, each.outcome]), [['call-2', 'ok'], ['call-1', 'ok']]);
  assert.equal((await call(a, turn, 'call-2', 'save_note', { id: 'x' })).kind, 'unchanged', 'a refused run again leaves the call that answered');
});

test('a call runs on a turn another device marked interrupted, and on no message its writer ended or another replica wrote', async (t) => {
  const { a, b } = await phones(t);
  const turn = await open(a);
  await a.sync();
  assert.equal((await b.runner.run(new EndTurn(turn.coach, 'interrupted'))).kind, 'committed');
  await b.sync();
  assert.equal(coach(a, turn).state, 'interrupted');
  answered(await call(a, turn, 'call-1', 'list_notes', {}));

  const elsewhere = await call(b, turn, 'call-2', 'list_notes', {});
  assert.deepEqual([elsewhere.kind, /** @type {any} */ (elsewhere).refusal?.refused?.code], ['refused', 'message-final']);

  assert.equal((await a.runner.run(new EndTurn(turn.coach, 'completed', 'Done.'))).kind, 'committed');
  const ended = await call(a, turn, 'call-3', 'list_notes', {});
  assert.deepEqual([ended.kind, /** @type {any} */ (ended).refusal?.refused?.code], ['refused', 'message-final']);
  assert.deepEqual(coach(a, turn).calls.map((each) => each.callId), ['call-1']);
});

test('a call on a turn its own writer ended interrupted is refused as final', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  assert.equal((await a.runner.run(new EndTurn(turn.coach, 'interrupted'))).kind, 'committed');
  const late = await call(a, turn, 'call-1', 'list_notes', {});
  assert.deepEqual([late.kind, /** @type {any} */ (late).refusal?.refused?.code], ['refused', 'message-final']);
  assert.deepEqual(coach(a, turn).calls, []);
});

test('a share the door made is recorded on the Coach message as any call, and the door\'s refusal as its code', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  const made = new AbilityRequest('call-1', 'share_session', { sessionId: 'session-1' });
  const result = { kind: 'result', jcs: new TextEncoder().encode('{"url":"u"}'), sha256: '' };
  assert.equal(answered(await a.runner.run(new RecordShareCall(made, turn.coach, /** @type {any} */ (result)))), result);
  const refused = { kind: 'refused', code: 'refused' };
  assert.deepEqual(answered(await a.runner.run(new RecordShareCall(new AbilityRequest('call-2', 'revoke_share', { sessionId: 'session-1' }), turn.coach, /** @type {any} */ (refused)))), refused);
  assert.deepEqual(coach(a, turn).calls.map((each) => [each.callId, each.name, each.outcome, each.input]),
    [['call-1', 'share_session', 'ok', { sessionId: 'session-1' }], ['call-2', 'revoke_share', 'refused', { sessionId: 'session-1' }]]);
  assert.throws(() => new RecordShareCall(new AbilityRequest('call-3', 'list_notes', {}), turn.coach, /** @type {any} */ (refused)), TypeError);
});

test('a refused call records its refusal alone and writes nothing of its ability', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  const outcome = answered(await call(a, turn, 'call-1', 'save_note', note('')));
  assert.deepEqual(outcome, { kind: 'refused', code: 'invalid-arguments' });
  const withheld = answered(await call(a, turn, 'call-2', 'start_session', { id: 'session0001', startedAt: 1 }));
  assert.deepEqual(withheld, { kind: 'refused', code: 'not-offered' });
  const share = answered(await call(a, turn, 'call-3', 'share_session', { sessionId: 'session0001' }));
  assert.deepEqual(share, { kind: 'refused', code: 'not-offered' });
  const anon = await a.runner.run(new RunAbility(new AbilityRequest('call-4', 'save_note', note('Knee')), turn.coach, 'anon', catalog, 'https://windmill.works'));
  assert.deepEqual(answered(anon), { kind: 'refused', code: 'seat-required' });
  assert.deepEqual(a.drawn(Note), []);
  assert.deepEqual(coach(a, turn).calls.map((each) => [each.callId, each.outcome, each.created.length]),
    [['call-1', 'invalid-arguments', 0], ['call-2', 'not-offered', 0], ['call-3', 'not-offered', 0], ['call-4', 'seat-required', 0]]);
});

test('an input the bounds refuse is invalid arguments, one the schema refuses invalid input, and neither reaches the store', async (t) => {
  const { a } = await phones(t);
  const turn = await open(a);
  assert.deepEqual(answered(await call(a, turn, 'call-1', 'list_sessions', { before: null, beforeId: null, limit: 201 })), { kind: 'refused', code: 'invalid-arguments' });
  assert.deepEqual(answered(await call(a, turn, 'call-2', 'list_sessions', { before: null, beforeId: 'x', limit: 20 })), { kind: 'refused', code: 'invalid-arguments' });
  assert.deepEqual(answered(await call(a, turn, 'call-3', 'list_sessions', { limit: 20 })), { kind: 'refused', code: 'invalid-input' });
  let deep = /** @type {any} */ ({});
  for (let level = 0; level < 40; level += 1) deep = { nested: deep };
  assert.deepEqual(answered(await call(a, turn, 'call-4', 'list_exercises', deep)), { kind: 'refused', code: 'invalid-input' });
});
