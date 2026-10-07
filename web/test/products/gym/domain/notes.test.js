// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { GymProduct } from '../../../../../packages/api-contract/sync/reference/gym/product.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { Placement } from '../../../../src/platform/domain-kit/reading.js';
import { CONSTANTS } from '../../../../src/platform/sync/core/constants.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { GymRefusals, GymRules, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { DeleteNote, MoveNote, Note, NoteValue, SaveNoteCall } from '../../../../src/products/gym/domain/notes.js';
import { RegistryCheck } from '../../../platform/domain-kit/checks.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { DEFAULT_NOW } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../../src/platform/domain-kit/refusals.js').DomainNotice<import('../../../../src/products/gym/domain/gymRules.js').GymRefusal>} Notice */

let nextNoteId = 0;
const noteId = () => new Id(`note${String(++nextNoteId).padStart(8, '0')}`, Note);

/** @param {import('node:test').TestContext} t */
async function open(t) {
  const a = await Harness.open({ registry, product: new GymProduct(), scope: Note.scope });
  t.after(() => a.close());
  return a;
}

/** @param {string} title @param {string} [body] */
function draft(title, body = '') {
  const id = noteId();
  return Draft.new(new NoteValue(id), Placement.bottom).edit(() => new NoteValue(id, title, body));
}

/** @param {Harness} phone @param {string} title @param {string} [body] */
async function add(phone, title, body = '') {
  const saved = await phone.runner.save(draft(title, body), GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  return saved.draft;
}

/** @param {Harness} phone @param {number} count */
async function seed(phone, count) {
  /** @type {Draft<NoteValue>[]} */
  const notes = [];
  for (let n = 1; n <= count; n += 1) notes.push(await add(phone, `Note ${n}`));
  return notes;
}

/** @param {Harness} phone @param {Id<NoteValue>} id */
function editing(phone, id) {
  const value = phone.runner.open(Note, id);
  assert.ok(value);
  return value;
}

/** @param {Harness} phone */
const fields = (phone) => phone.drawn(Note).map((value) => ({ id: value.id.record, ...value.fields() }));

/** @param {Harness} phone @param {'drawn' | 'stored'} [view] */
const ids = (phone, view = 'drawn') => phone[view](Note).map((value) => value.id.record);

test('note content time is read without entering the client write fields and the declaration matches the registry', () => {
  for (const updatedAt of [null, DEFAULT_NOW]) {
    const note = Note.decode(Fields.values('note', 'note0001', { title: 'Tone', body: 'Blunt.', updatedAt }));
    assert.equal(note.updatedAt?.ms ?? null, updatedAt);
    assert.deepEqual(note.fields(), { title: 'Tone', body: 'Blunt.' });
    RegistryCheck.entity(Note, note, GymRules.book);
  }
});

test('a note storage failure retains its draft, writes nothing durable and retries with normalised fields', async (t) => {
  const a = await open(t);
  const held = draft(' Cafe\u0301 ', ' Blunt.\n');
  const before = (await a.engine.store.read()).device.toJSON();
  a.failNextCommit();
  const failed = await a.runner.save(held, GymRefusals);
  assert.equal(failed.result.kind, 'failed');
  assert.equal(failed.draft, held);
  assert.deepEqual((await a.engine.store.read()).device.toJSON(), before);
  assert.deepEqual(fields(a), []);
  assert.deepEqual(a.env.failures, ['storage']);
  const saved = await a.runner.save(failed.draft, GymRefusals);
  assert.equal(saved.result.kind, 'saved');
  assert.equal(saved.draft.isNew, false);
  assert.equal(saved.draft.isDirty, false);
  assert.deepEqual(saved.draft.current.fields(), { title: 'Café', body: 'Blunt.' });
  await a.sync();
  assert.deepEqual(fields(a), [{ id: held.id.record, title: 'Café', body: 'Blunt.' }]);
  assert.deepEqual((await a.runner.save(saved.draft, GymRefusals)).result, { kind: 'saved', receipt: null });
});

test('invalid note text retains its draft without an engine intent or storage failure', async (t) => {
  const a = await open(t);
  const samples = [
    { title: ' ', body: '', violation: { rule: 'note.title', path: 'title', reason: 'blank' } },
    { title: '😀'.repeat(61), body: '', violation: { rule: 'note.title', path: 'title', reason: 'tooLong', max: 60, unit: 'chars', measured: 61 } },
    { title: 'Tone', body: 'é'.repeat(251), violation: { rule: 'note.body', path: 'body', reason: 'tooLong', max: 500, unit: 'bytes', measured: 502 } },
    { title: 'Tone', body: 'a\u0000b', violation: { rule: 'note.body', path: 'body', reason: 'nul' } },
  ];
  for (const sample of samples) {
    const held = draft(sample.title, sample.body);
    const saved = await a.runner.save(held, GymRefusals);
    assert.deepEqual(saved.result.kind === 'refused' && refusalForm(saved.result.refusal), { invalid: sample.violation });
    assert.equal(saved.draft, held);
  }
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  assert.deepEqual(a.env.failures, []);
});

test('a held note keeps its cap slot and place through Undo and releases them when its window ends', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const notes = await seed(a, 10);
  const first = notes[0];
  assert.ok(first);
  const order = ids(a);
  await a.sync();
  const extra = draft('Note 11');
  const full = { full: { type: 'note', cap: 10, path: 'predicted' } };
  let saved = await a.runner.save(extra, GymRefusals);
  assert.deepEqual(saved.result.kind === 'refused' && refusalForm(saved.result.refusal), full);
  const removed = await a.runner.run(DeleteNote(first.id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  assert.equal(removed.receipt.releaseAt, DEFAULT_NOW + CONSTANTS.HOLD_MS);
  assert.deepEqual(a.undoOffers(), [{ id: removed.receipt.gestureId, releaseAt: removed.receipt.releaseAt, records: [first.id.ref] }]);
  assert.deepEqual(ids(a), order.slice(1));
  assert.deepEqual(ids(a, 'stored'), order);
  assert.deepEqual(a.runner.read(Note.scope, (read) => {
    const cap = read.repository(Note).capacity();
    return { used: cap.used, cap: cap.cap, isFull: cap.isFull };
  }), { used: 10, cap: 10, isFull: true });
  saved = await a.runner.save(extra, GymRefusals);
  assert.deepEqual(saved.result.kind === 'refused' && refusalForm(saved.result.refusal), full);
  assert.equal(saved.draft, extra);
  assert.deepEqual(await a.runner.run(DeleteNote(first.id)), { kind: 'unchanged', result: null });
  await a.sync();
  assert.deepEqual(ids(b), order);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(ids(a), order);
  const again = await a.runner.run(DeleteNote(first.id));
  assert.equal(again.kind, 'committed');
  if (again.kind !== 'committed') return;
  await a.advance(CONSTANTS.HOLD_MS - 1);
  assert.equal(a.undoOffers().length, 1);
  await a.advance(1);
  assert.deepEqual(a.undoOffers(), []);
  assert.equal(await a.runner.undo(again.receipt.gestureId), false);
  assert.equal((await a.runner.save(extra, GymRefusals)).result.kind, 'saved');
  await a.sync();
  assert.deepEqual(ids(a), [...order.slice(1), extra.id.record]);
  assert.deepEqual(fields(b), fields(a));
});

test('a new note is placed below the last stored note while that note is held', async (t) => {
  const a = await open(t);
  const one = await add(a, 'One');
  const two = await add(a, 'Two');
  const removed = await a.runner.run(DeleteNote(two.id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  const three = await add(a, 'Three');
  assert.deepEqual(ids(a), [one.id.record, three.id.record]);
  assert.deepEqual(ids(a, 'stored'), [one.id.record, two.id.record, three.id.record]);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(ids(a), [one.id.record, two.id.record, three.id.record]);
});

test('edits guard and write only touched fields so two devices retain both changes', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const note = await add(a, 'Tone', 'Blunt.');
  await a.sync();
  const onA = editing(a, note.id).edit((value) => new NoteValue(value.id, value.title, 'Blunt. No pep talks.'));
  const onB = editing(b, note.id).edit((value) => new NoteValue(value.id, 'How I want to be talked to', value.body));
  assert.deepEqual(onA.touched, ['body']);
  assert.deepEqual(onB.touched, ['title']);
  assert.equal((await a.runner.save(onA, GymRefusals)).result.kind, 'saved');
  assert.equal((await b.runner.save(onB, GymRefusals)).result.kind, 'saved');
  for (const [phone, field] of /** @type {const} */ ([[a, 'body'], [b, 'title']])) {
    const entry = phone.engine.device.activeReplica.entries().at(-1);
    assert.deepEqual(entry.intent.d.map((/** @type {any} */ delta) => ({ t: delta.t, id: delta.id, fields: Object.keys(delta.f) })), [{ t: 'note', id: note.id.record, fields: [field] }]);
    assert.deepEqual(entry.intent.guard.map((/** @type {any} */ guard) => ({ t: guard.t, id: guard.id, field: guard.field })), [{ t: 'note', id: note.id.record, field }]);
  }
  await a.sync();
  assert.deepEqual(fields(a), [{ id: note.id.record, title: 'How I want to be talked to', body: 'Blunt. No pep talks.' }]);
  assert.deepEqual(fields(b), fields(a));
  assert.deepEqual(a.notices(GymRefusals), []);
  assert.deepEqual(b.notices(GymRefusals), []);
});

test('a stale note draft keeps its words and Keep mine rebases untouched fields before saving', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const note = await add(a, 'Tone', 'Blunt.');
  await a.sync();
  const mine = editing(a, note.id).edit((value) => new NoteValue(value.id, 'Tone, from A', value.body));
  const theirs = editing(b, note.id).edit((value) => new NoteValue(value.id, 'Tone, from B', 'Blunt, from B.'));
  await b.runner.save(theirs, GymRefusals);
  await a.sync();
  const refused = await a.runner.save(mine, GymRefusals);
  assert.deepEqual(refused.result.kind === 'refused' && refusalForm(refused.result.refusal), { stale: { subject: note.id.ref, path: 'predicted' } });
  assert.equal(refused.draft, mine);
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  const rebased = mine.rebased(editing(a, note.id).current);
  assert.deepEqual(rebased.touched, ['title']);
  assert.deepEqual(rebased.current.fields(), { title: 'Tone, from A', body: 'Blunt, from B.' });
  assert.equal((await a.runner.save(rebased, GymRefusals)).result.kind, 'saved');
  await a.sync();
  assert.deepEqual(fields(b), [{ id: note.id.record, title: 'Tone, from A', body: 'Blunt, from B.' }]);
});

test('competing edits produce a stale notice holding the refused field and Take theirs reopens the stored note', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const note = await add(a, 'Tone');
  await a.sync();
  const mine = editing(a, note.id).edit((value) => new NoteValue(value.id, 'Tone, from A', value.body));
  const theirs = editing(b, note.id).edit((value) => new NoteValue(value.id, 'Tone, from B', value.body));
  await a.runner.save(mine, GymRefusals);
  await b.runner.save(theirs, GymRefusals);
  await a.sync();
  const notices = /** @type {Notice[]} */ (b.notices(GymRefusals));
  assert.deepEqual(notices.map((notice) => refusalForm(notice.refusal)), [{ stale: { subject: note.id.ref, path: 'notice' } }]);
  assert.deepEqual(notices.map((notice) => notice.values(note.id.ref)), [{ title: 'Tone, from B' }]);
  const reopened = editing(b, note.id);
  assert.deepEqual(reopened.current.fields(), { title: 'Tone, from A', body: '' });
  assert.equal(reopened.isDirty, false);
  assert.deepEqual(fields(b), fields(a));
});

for (const arriving of [true, false]) test(`a note deleted on another device is gone ${arriving ? 'before save' : 'in a notice retaining its edit'}`, async (t) => {
  const a = await open(t);
  const b = await a.device();
  const note = await add(a, 'Tone');
  await a.sync();
  const held = editing(b, note.id).edit((value) => new NoteValue(value.id, 'Tone, kept', value.body));
  await a.runner.run(DeleteNote(note.id));
  await a.advance(CONSTANTS.HOLD_MS);
  if (arriving) await a.sync();
  const saved = await b.runner.save(held, GymRefusals);
  if (arriving) {
    assert.deepEqual(saved.result.kind === 'refused' && refusalForm(saved.result.refusal), { gone: { subject: note.id.ref, path: 'predicted' } });
    assert.equal(saved.draft, held);
  } else {
    assert.equal(saved.result.kind, 'saved');
    await a.sync();
    const notices = /** @type {Notice[]} */ (b.notices(GymRefusals));
    assert.deepEqual(notices.map((notice) => refusalForm(notice.refusal)), [{ gone: { subject: note.id.ref, path: 'notice' } }]);
    assert.deepEqual(notices.map((notice) => notice.values(note.id.ref)), [{ title: 'Tone, kept' }]);
  }
  assert.deepEqual(fields(b), []);
});

test('two devices adding the tenth note converge and the full notice retains the refused words', async (t) => {
  const a = await open(t);
  const b = await a.device();
  await seed(a, 9);
  await a.sync();
  await add(a, 'From A');
  const fromB = await add(b, 'From B', 'Kept in the notice.');
  await a.sync();
  const notices = /** @type {Notice[]} */ (b.notices(GymRefusals));
  assert.deepEqual(notices.map((notice) => refusalForm(notice.refusal)), [{ full: { type: 'note', cap: 10, path: 'notice' } }]);
  assert.deepEqual(notices.map((notice) => notice.values(fromB.id.ref)), [{ title: 'From B', body: 'Kept in the notice.', ord: 'a9' }]);
  assert.deepEqual(fields(b), fields(a));
  assert.deepEqual(a.drawn(Note).map((note) => note.title), [...Array.from({ length: 9 }, (_, i) => `Note ${i + 1}`), 'From A']);
});

test('a move writes only the dragged note order field and a drop in place writes nothing', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const one = await add(a, 'One');
  const two = await add(a, 'Two');
  const three = await add(a, 'Three');
  await a.sync();
  assert.deepEqual(await a.runner.run(MoveNote(two.id, one.id)), { kind: 'unchanged', result: null });
  assert.deepEqual(await a.runner.run(MoveNote(one.id, one.id)), { kind: 'unchanged', result: null });
  assert.deepEqual(a.engine.device.activeReplica.entries(), []);
  assert.equal((await a.runner.run(MoveNote(one.id, two.id))).kind, 'committed');
  const entry = a.engine.device.activeReplica.entries().at(-1);
  assert.deepEqual(entry.intent.d.map((/** @type {any} */ delta) => ({ t: delta.t, id: delta.id, fields: Object.keys(delta.f) })), [{ t: 'note', id: one.id.record, fields: ['ord'] }]);
  assert.deepEqual(ids(a), [two.id.record, one.id.record, three.id.record]);
  await a.sync();
  assert.deepEqual(fields(b), fields(a));
  assert.equal((await a.runner.run(MoveNote(three.id, null))).kind, 'committed');
  await a.sync();
  assert.deepEqual(ids(b), [three.id.record, two.id.record, one.id.record]);
  assert.deepEqual(a.notices(GymRefusals), []);
  assert.deepEqual(b.notices(GymRefusals), []);
});

test('a drag across a held note keeps its place and Undo, while a drawn drop in place writes nothing', async (t) => {
  const a = await open(t);
  const b = await a.device();
  const one = await add(a, 'One');
  const two = await add(a, 'Two');
  const three = await add(a, 'Three');
  await a.sync();
  const removed = await a.runner.run(DeleteNote(two.id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  const before = structuredClone(a.engine.device.activeReplica.entries());
  assert.deepEqual(await a.runner.run(MoveNote(three.id, one.id)), { kind: 'unchanged', result: null });
  assert.deepEqual(a.engine.device.activeReplica.entries(), before);
  const hidden = await a.runner.run(MoveNote(two.id, three.id));
  assert.deepEqual(hidden.kind === 'refused' && refusalForm(hidden.refusal), { gone: { subject: two.id.ref, path: 'predicted' } });
  assert.equal((await a.runner.run(MoveNote(one.id, three.id))).kind, 'committed');
  const entry = a.engine.device.activeReplica.entries().at(-1);
  assert.deepEqual(entry.intent.d.map((/** @type {any} */ delta) => ({ t: delta.t, id: delta.id, fields: Object.keys(delta.f) })), [{ t: 'note', id: one.id.record, fields: ['ord'] }]);
  assert.deepEqual(ids(a), [three.id.record, one.id.record]);
  assert.deepEqual(ids(a, 'stored'), [two.id.record, three.id.record, one.id.record]);
  assert.deepEqual(a.undoOffers(), [{ id: removed.receipt.gestureId, releaseAt: removed.receipt.releaseAt, records: [two.id.ref] }]);
  await a.sync();
  assert.deepEqual(ids(b), [two.id.record, three.id.record, one.id.record]);
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(fields(a), fields(b));
  assert.deepEqual(a.undoOffers(), []);
});

test('a note call appends normalised words and its replay preserves the person’s later edit', async (t) => {
  const a = await open(t);
  await add(a, 'What I am training for');
  const id = noteId();
  const call = new SaveNoteCall(new NoteValue(id, ' Knee ', ' No deep lunges. '));
  const outcome = await a.runner.run(call);
  assert.equal(outcome.kind, 'committed');
  assert.ok(outcome.kind === 'committed' && outcome.result.equals(id));
  assert.deepEqual(a.drawn(Note).map((note) => note.fields()), [{ title: 'What I am training for', body: '' }, { title: 'Knee', body: 'No deep lunges.' }]);
  const edited = editing(a, id).edit((value) => new NoteValue(value.id, value.title, 'No deep lunges, ever.'));
  await a.runner.save(edited, GymRefusals);
  assert.deepEqual(await a.runner.run(call), { kind: 'unchanged', result: id });
  await a.sync();
  assert.deepEqual(a.drawn(Note).map((note) => note.body), ['', 'No deep lunges, ever.']);
});

test('a note call reuses identical stored words at the cap and during a held deletion', async (t) => {
  const a = await open(t);
  const notes = await seed(a, 10);
  const last = notes.at(-1);
  assert.ok(last);
  const removed = await a.runner.run(DeleteNote(last.id));
  assert.equal(removed.kind, 'committed');
  if (removed.kind !== 'committed') return;
  const duplicate = new SaveNoteCall(new NoteValue(noteId(), ' Note 10 ', ' '));
  assert.deepEqual(await a.runner.run(duplicate), { kind: 'unchanged', result: last.id });
  const extra = new SaveNoteCall(new NoteValue(noteId(), 'Knee'));
  const refused = await a.runner.run(extra);
  assert.deepEqual(refused.kind === 'refused' && refusalForm(refused.refusal), { full: { type: 'note', cap: 10, path: 'predicted' } });
  assert.equal(await a.runner.undo(removed.receipt.gestureId), true);
  assert.deepEqual(ids(a), notes.map((note) => note.id.record));
});

test('a replay during its delete window is done and a replay after release returns as a taken notice', async (t) => {
  const a = await open(t);
  const id = noteId();
  const call = new SaveNoteCall(new NoteValue(id, 'Knee'));
  assert.equal((await a.runner.run(call)).kind, 'committed');
  await a.sync();
  await a.runner.run(DeleteNote(id));
  assert.deepEqual(await a.runner.run(call), { kind: 'unchanged', result: id });
  await a.advance(CONSTANTS.HOLD_MS);
  await a.sync();
  assert.equal((await a.runner.run(call)).kind, 'committed');
  await a.sync();
  assert.deepEqual(a.notices(GymRefusals).map((/** @type {Notice} */ notice) => refusalForm(notice.refusal)), [{ taken: { subject: id.ref, path: 'notice' } }]);
  assert.deepEqual(fields(a), []);
});
