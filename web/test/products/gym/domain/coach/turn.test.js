// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Fields, Id } from '../../../../../src/platform/domain-kit/entities.js';
import { Instant } from '../../../../../src/platform/domain-kit/time.js';
import { registry } from '../../../../../src/platform/sync/schema.js';
import { AbilityCall, CoachBook, CoachMessage, CoachMessageValue, CoachThread, CoachThreadValue, Conversation, Picture } from '../../../../../src/products/gym/domain/coach/conversation.js';
import { BeginRound, CoachPictureRow, DeleteConversation, EndTurn, ForgetCoachAtSignOut, ForgetUnclaimedPictures, KeepPicture, Mark, OpenTurn,
  PictureCopy, RecoverMark, StreamTurnText, WithdrawTurn } from '../../../../../src/products/gym/domain/coach/turn.js';
import { RegistryCheck } from '../../../../platform/domain-kit/checks.js';
import { Harness } from '../../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../../src/products/gym/domain/coach/turn.js').Turn} Turn */

/** @param {import('node:test').TestContext} t */
async function phones(t) {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: CoachMessage.scope });
  const b = await a.device();
  t.after(() => a.close());
  return { a, b };
}

/** @param {Harness} phone @param {any} action */
async function committed(phone, action) {
  const outcome = await phone.runner.run(action);
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return /** @type {any} */ (outcome).result;
}

/** @param {Harness} phone @param {string} [prefix] */
const rows = (phone, prefix = '') => phone.runner.read(CoachMessage.scope, (read) => read.devices(prefix));

/** @param {Harness} phone @param {string} [question] @param {Picture[]} [pictures] @returns {Promise<Turn>} */
const open = (phone, question = 'How heavy today?', pictures = []) => committed(phone, new OpenTurn({ question, pictures }));

const picture = new CoachPictureRow('picture00000001', new PictureCopy('image/jpeg', 4032, 3024, 'AAAA'), new PictureCopy('image/jpeg', 1568, 1176, 'AAA='));
const callId = 'call00000000000000000a';

test('the thread and the message agree with the registry, and an unknown state reads as running', () => {
  const thread = new Id('thread00000001', CoachThread);
  RegistryCheck.entity(CoachThread, new CoachThreadValue(thread, 'How heavy today?'), CoachBook.book);
  RegistryCheck.entity(CoachMessage, new CoachMessageValue({ id: new Id('coach000000001', CoachMessage), threadId: thread, role: 'coach',
    replica: 'rp_00000000000000000000000000000001', text: 'Add 5 kg.', state: 'completed', truncated: false, receipt: AbilityCall.receipt([]),
    calls: [new AbilityCall({ callId: 'call-1', name: 'list_notes', input: {}, outcome: 'ok' })], pictures: [new Picture('picture00000001', 'image/png', true)],
    at: new Instant(DEFAULT_NOW) }), CoachBook.book);
  const later = CoachMessage.decode(Fields.values('message', 'coach000000001', { threadId: 'thread00000001', role: 'coach', at: 1, state: 'thinking' }));
  assert.equal(later.state, 'running');
  assert.deepEqual(later.calls, []);
});

test('a conversation a phone wrote reads back in the browser, in the order it was said', async (t) => {
  const { a, b } = await phones(t);
  // The bytes a phone's OpenTurn and EndTurn write (gym/domain/coach-conversation-actions.json), committed raw.
  await b.engine.commit(CoachMessage.scope, [
    { op: 'create', t: 'thread', id: 'thread00000001', f: { title: 'How heavy today?' } },
    { op: 'create', t: 'message', id: 'lifter00000001', f: { threadId: 'thread00000001', role: 'lifter', at: DEFAULT_NOW, text: 'How heavy today?' } },
    { op: 'create', t: 'message', id: 'coach000000001', f: { threadId: 'thread00000001', role: 'coach', at: DEFAULT_NOW, text: '',
      replica: 'rp_99999999999999999999999999999999', state: 'running', truncated: false, calls: [] } },
  ], { atomic: true });
  await b.engine.commit(CoachMessage.scope, [{ op: 'update', t: 'message', id: 'coach000000001', f: { state: 'completed', text: 'Add 5 kg.',
    truncated: false, receipt: { read: { sets: 0, sessions: 0, weeks: 0 }, results: [] } } }]);
  await a.sync();
  assert.deepEqual(a.drawn(CoachThread).map((thread) => ({ id: thread.id.record, ...thread.fields() })), [{ id: 'thread00000001', title: 'How heavy today?' }]);
  const conversation = new Conversation(a.runner.read(CoachMessage.scope, (read) => read.repository(CoachMessage).children(new Id('thread00000001', CoachThread), 'threadId', 'drawn')));
  assert.deepEqual(conversation.messages.map((message) => ({ id: message.id.record, ...message.fields() })), [
    { id: 'lifter00000001', threadId: 'thread00000001', role: 'lifter', at: DEFAULT_NOW, text: 'How heavy today?' },
    { id: 'coach000000001', threadId: 'thread00000001', role: 'coach', at: DEFAULT_NOW, text: 'Add 5 kg.', replica: 'rp_99999999999999999999999999999999',
      state: 'completed', truncated: false, receipt: { read: { sets: 0, sessions: 0, weeks: 0 }, results: [] }, calls: [] },
  ]);
  assert.deepEqual(conversation.history(new Id('coach000000002', CoachMessage)).map((message) => message.id.record), ['lifter00000001', 'coach000000001']);
});

test('a turn opens with its mark, its rounds name it, and its end clears the turn and the round in one write', async (t) => {
  const { a, b } = await phones(t);
  await committed(a, new KeepPicture(picture));
  const turn = await open(a, 'This one?', [new Picture(picture.id, 'image/jpeg', true)]);
  assert.deepEqual(rows(a, 'running'), { runningTurn: turn.coach.record });
  await committed(a, new BeginRound(turn.coach, callId, 0));
  await committed(a, new StreamTurnText(turn.coach, 'Add 5'));
  assert.deepEqual(rows(a, 'running'), { runningTurn: turn.coach.record, runningRound: { message: turn.coach.record, callId, bytesBefore: 0 } });
  const mark = a.runner.read(CoachMessage.scope, Mark.read);
  assert.deepEqual([mark.turnId, mark.callId, mark.textBytesBeforeRound], [turn.coach.record, callId, 0]);
  await a.sync();
  assert.deepEqual(rows(b), {}, 'the mark and the picture never leave the browser');
  assert.equal(b.drawn(CoachMessage).find((message) => message.id.equals(turn.coach))?.text, 'Add 5');

  await committed(a, new EndTurn(turn.coach, 'completed', 'Add 5 kg.'));
  assert.deepEqual(rows(a, 'running'), {});
  assert.deepEqual(rows(a, 'picture:'), { [CoachPictureRow.key(picture.id)]: picture.json });
  const refused = await a.runner.run(new BeginRound(turn.coach, callId, 9));
  assert.equal(refused.kind, 'refused');
  assert.equal(CoachPictureRow.decode(picture.id, picture.json)?.model.bytes, 2);
});

test('a round row naming another message counts as no round and the recovery clears it', async (t) => {
  const { a } = await phones(t);
  const first = await open(a);
  await committed(a, new BeginRound(first.coach, callId, 12));
  await committed(a, new EndTurn(first.coach, 'completed', 'Done.'));
  const second = await open(a, 'And tomorrow?');
  await a.engine.commit(CoachMessage.scope, [], { local: { runningRound: { message: first.coach.record, callId, bytesBefore: 12 } } });
  const stale = a.runner.read(CoachMessage.scope, Mark.read);
  assert.deepEqual([stale.turnId, stale.callId, stale.textBytesBeforeRound, stale.roundIsStale], [second.coach.record, null, 0, true]);
  const recovered = await committed(a, new RecoverMark());
  assert.deepEqual([recovered.turnId, recovered.callId], [second.coach.record, null]);
  assert.deepEqual(rows(a, 'running'), { runningTurn: second.coach.record });
  await a.engine.commit(CoachMessage.scope, [], { local: { runningRound: { message: second.coach.record, callId: 'short', bytesBefore: 0 } } });
  assert.equal(a.runner.read(CoachMessage.scope, Mark.read).callId, null, 'a malformed round is no round');
  assert.equal((await a.runner.run(new RecoverMark())).kind, 'committed');
  assert.equal((await a.runner.run(new RecoverMark())).kind, 'unchanged');
});

test('a writer goes on answering a turn another device marked interrupted, and its end stands', async (t) => {
  const { a, b } = await phones(t);
  const turn = await open(a);
  await a.sync();
  await committed(b, new EndTurn(turn.coach, 'interrupted'));
  assert.equal((await b.runner.run(new StreamTurnText(turn.coach, 'Not mine'))).kind, 'unchanged', 'another replica writes no text');
  await b.sync();
  await committed(a, new StreamTurnText(turn.coach, 'Add 5 kg.'));
  await committed(a, new EndTurn(turn.coach, 'completed'));
  await a.sync();
  for (const phone of [a, b]) {
    const message = phone.drawn(CoachMessage).find((each) => each.id.equals(turn.coach));
    assert.deepEqual([message?.state, message?.text], ['completed', 'Add 5 kg.']);
  }
});

test('a withdrawn turn and a deleted conversation take their messages, pictures and the whole mark', async (t) => {
  const { a } = await phones(t);
  await committed(a, new KeepPicture(picture));
  const withdrawn = await open(a, 'This one?', [new Picture(picture.id, 'image/jpeg', true)]);
  await committed(a, new BeginRound(withdrawn.coach, callId, 0));
  assert.deepEqual(await committed(a, new WithdrawTurn(withdrawn)), [picture.id]);
  assert.deepEqual(rows(a), {});
  assert.deepEqual([a.drawn(CoachThread), a.drawn(CoachMessage)], [[], []]);

  const turn = await open(a);
  await committed(a, new BeginRound(turn.coach, callId, 0));
  assert.deepEqual(await committed(a, new DeleteConversation(turn.thread)), []);
  assert.deepEqual(rows(a), {});
  assert.deepEqual([a.drawn(CoachThread), a.drawn(CoachMessage)], [[], []]);
  assert.equal((await a.runner.run(new DeleteConversation(turn.thread))).kind, 'unchanged');
});

test('a picture no message claims goes once the replica is caught up with its log', async (t) => {
  const { a } = await phones(t);
  await committed(a, new KeepPicture(picture));
  await committed(a, new KeepPicture(new CoachPictureRow('picture00000002', picture.original, picture.model)));
  await open(a, 'This one?', [new Picture('picture00000002', 'image/jpeg', true)]);
  await a.sync();
  await committed(a, new ForgetUnclaimedPictures());
  assert.deepEqual(Object.keys(rows(a, 'picture:')), ['picture:picture00000002']);
});

/** @param {Harness} phone */
async function persisted(phone) { return JSON.stringify((await phone.engine.store.read()).device.toJSON()); }

for (const choice of /** @type {const} */ (['keep', 'discard'])) {
  test(`after a sign-out with ${choice}, nothing of Coach is left in the browser's storage`, async (t) => {
    const { a } = await phones(t);
    await committed(a, new KeepPicture(picture));
    const turn = await open(a, 'How heavy today?', [new Picture(picture.id, 'image/jpeg', true)]);
    await committed(a, new BeginRound(turn.coach, callId, 0));
    await committed(a, new StreamTurnText(turn.coach, 'Add 5 kg.'));
    await a.sync();
    assert.match(await persisted(a), /runningRound/);
    assert.deepEqual(await committed(a, new ForgetCoachAtSignOut()), [picture.id]);
    a.engine.online = false;
    await a.engine.beginSignOut();
    assert.equal((await a.engine.finishSignOut({ choice })).complete, true);
    const stored = await persisted(a);
    for (const residue of ['runningTurn', 'runningRound', 'picture:', picture.model.data + '"', 'How heavy today?', 'Add 5 kg.', String(turn.coach.record)]) {
      assert.equal(stored.includes(residue), false, `${residue} stayed in the browser`);
    }
  });
}

test('a picture an unsent question names stays with the unsent work a Keep keeps', async (t) => {
  const { a } = await phones(t);
  await committed(a, new KeepPicture(picture));
  await committed(a, new KeepPicture(new CoachPictureRow('picture00000002', picture.original, picture.model)));
  a.engine.online = false;
  const turn = await open(a, 'This one?', [new Picture(picture.id, 'image/jpeg', true)]);
  assert.deepEqual(await committed(a, new ForgetCoachAtSignOut()), ['picture00000002']);
  assert.deepEqual(Object.keys(rows(a)), [CoachPictureRow.key(picture.id)]);
  assert.equal((await a.engine.beginSignOut()).unsent, 1);
  assert.equal((await a.engine.finishSignOut({ choice: 'keep' })).complete, true);
  const stored = await persisted(a);
  assert.equal(stored.includes(CoachPictureRow.key(picture.id)), true);
  assert.equal(stored.includes('runningTurn'), false);
  assert.equal(stored.includes(String(turn.coach.record)), true, 'the unsent turn waits for the next sign-in');
});
