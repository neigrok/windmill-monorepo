// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { IDSource, decision } from '../../../../src/platform/domain-kit/actions.js';
import { Reader, Views } from '../../../../src/platform/domain-kit/reading.js';
import { translate } from '../../../../src/platform/domain-kit/translation.js';
import { registry } from '../../../../src/platform/sync/schema.js';
import { JournalRoom, JOURNAL_SCOPE, PageDocument } from '../../../../src/products/journal/domain/page.js';
import { EditorDraft, JournalWriting, PendingClaim, PreserveEditorDraft, RetireJournalInvitation, SavePage } from '../../../../src/products/journal/domain/writing.js';
import { momentOf, viewRecords } from '../../../platform/domain-kit/vectors.js';

const day = '2026-10-01';
const document = { body: 'Local', mood: null, energy: null, source: 'typed' };
const stamp = { ms: 1790812800000, counter: 0, actor: 'writer:a' };
const row = { t: 'page', id: day, f: { mood: [null, '1:0:a'], energy: [null, '1:0:a'], source: ['typed', '1:0:a'],
  documentStamp: [stamp, '1:0:a'] }, x: { body: { text: 'Account', rev: 1, merged: false } } };

/** @param {any} [input] */
function reader(input = {}) {
  return new Reader(Views.ofRecords(registry, {
    drawn: viewRecords(input.drawn ?? []), stored: viewRecords(input.stored ?? input.drawn ?? []),
    confirmed: viewRecords(input.confirmed ?? input.drawn ?? []),
    devices: input.devices ?? {}, firstPullComplete: input.complete ?? true, actor: 'writer:a',
    isAnonymous: input.anonymous ?? false, commands: input.commands ?? [],
    checkpoint: input.checkpoint ?? { epoch: null, cleanSeq: null }, opaqueID: () => 'claim01',
  }), JOURNAL_SCOPE, momentOf({ now: stamp.ms }));
}

/** @param {JournalRoom} room */
function form(room) {
  return { stance: room.stance, firstRunKnown: room.firstRunKnown, isAnonymous: room.isAnonymous,
    scaleInvitationDue: room.scaleInvitationDue, keepDue: room.keepDue, state: room.state.fields(),
    pages: room.pages.map((page) => ({ day: page.day.text, document: page.document.fields(), stamp: page.documentStamp, backup: page.backup })),
    days: room.days.map((page) => page.day.text) };
}

test('an unread journal keeps first-run absence unknown', () => {
  assert.deepEqual(form(new JournalRoom(reader({ complete: false }))), {
    stance: 'unknown', firstRunKnown: false, isAnonymous: false, scaleInvitationDue: false, keepDue: false,
    state: { placeholder: 'pending', privacyLine: 'pending', firstPage: 'pending', scales: 'pending' }, pages: [], days: [],
  });
});

test('a confirmed page is backed up only after a complete pull and no queued write', () => {
  const clean = new JournalRoom(reader({ drawn: [row] }));
  assert.equal(clean.pages[0]?.backup, 'backedUp');
  const pending = new JournalRoom(reader({ drawn: [row], commands: [{ gestureId: 'g1', canSupersede: false,
    command: { name: 'journal.savePage', args: { day } } }] }));
  assert.equal(pending.pages[0]?.backup, 'pending');
  assert.equal(new JournalRoom(reader({ drawn: [row], complete: false })).pages[0]?.backup, 'pending');
});

test('retained deletion overlays account prose and preserves its first-run retirements', () => {
  const pending = new PendingClaim({ day, claimId: 'claim01', document, retirements: { firstPage: 'retired', privacyLine: 'retired', placeholder: 'retired' } });
  pending.edit({ ...document, body: '' });
  pending.refusal = 'claim-conflict';
  const room = new JournalRoom(reader({ drawn: [row], devices: { [pending.key]: pending.json } }));
  assert.deepEqual(form(room), {
    stance: 'holding', firstRunKnown: true, isAnonymous: false, scaleInvitationDue: true, keepDue: false,
    state: { placeholder: 'retired', privacyLine: 'retired', firstPage: 'retired', scales: 'pending' },
    pages: [{ day, document: { ...document, body: '' }, stamp, backup: 'refused' }], days: [],
  });
});

test('zero-only pages are written and unsaved editor drafts are kept outside the page projection', () => {
  const pending = new PendingClaim({ day, claimId: 'claim01', document: { ...document, body: '', mood: 0 },
    retirements: { privacyLine: 'retired', firstPage: 'retired', scales: 'retired' } });
  const draft = new EditorDraft({ day, document: { ...document, body: 'Unsaved typing' } });
  const room = new JournalRoom(reader({ anonymous: true, devices: { [pending.key]: pending.json, [EditorDraft.key]: draft.json } }));
  assert.equal(room.days.length, 1);
  assert.equal(room.days[0]?.document.body, '');
  assert.equal(room.days[0]?.document.mood, 0);
  assert.equal(room.state.placeholder, 'pending');
  assert.equal(room.keepDue, true);
  assert.deepEqual(JournalWriting.pendingWork('journal', { [pending.key]: pending.json, [EditorDraft.key]: draft.json }), [EditorDraft.key, pending.key]);
  assert.deepEqual(JournalWriting.pendingWork('gym', { [pending.key]: pending.json }), []);
});

test('an editor draft round trips raw writing and keeps it as durable pending work', () => {
  const draft = new EditorDraft({ day, document: new PageDocument({ body: ' \tCafé\n', mood: 0 }) });
  assert.deepEqual(EditorDraft.fromJSON(draft.json).json, draft.json);
  const action = new PreserveEditorDraft({ day, document: draft.document });
  const read = reader();
  const result = decision(action, action.load(read), new IDSource(read.views));
  assert.equal(result.kind, 'write');
  if (result.kind !== 'write') return;
  assert.deepEqual(translate(result.plan, JOURNAL_SCOPE, registry), {
    changes: [], atomic: false, hold: false, guards: [], retire: [], cmd: null, predict: [], local: [{ key: EditorDraft.key, value: draft.json }],
  });
});

test('the first bound write before reading an account is a contribution', () => {
  const read = reader({ complete: false });
  const action = new SavePage({ day, document });
  const result = decision(action, action.load(read), new IDSource(read.views));
  assert.equal(result.kind, 'write');
  if (result.kind !== 'write') return;
  assert.equal(result.plan.command?.name, 'journal.claimPage');
  assert.deepEqual(result.plan.command?.args, { day, ...document, claimId: 'claim01' });
  assert.equal(result.plan.deviceWrites.some((write) => write.key === 'contentClock'), false);
  assert.equal(result.plan.deviceWrites[0]?.key, 'pendingClaim:claim01');
});

test('retiring an invitation while a claim is pending waits under that same receipt', () => {
  const pending = new PendingClaim({ day, claimId: 'claim01', document });
  const read = reader({ devices: { [pending.key]: pending.json } });
  const action = new RetireJournalInvitation({ field: 'scales' });
  const result = decision(action, action.load(read), new IDSource(read.views));
  assert.equal(result.kind, 'write');
  if (result.kind !== 'write') return;
  assert.deepEqual(result.plan.operations, []);
  assert.equal(result.plan.command, null);
  assert.deepEqual(result.plan.deviceWrites, [{ key: pending.key, value: { ...pending.json, retirements: { scales: 'retired' } } }]);
  assert.deepEqual(pending.retirements, {});
});

test('a successful save clears only the draft belonging to that day', () => {
  for (const draftDay of ['2026-09-30', day]) {
    const draft = new EditorDraft({ day: draftDay, document: { ...document, body: 'Retained writing' } });
    const read = reader({ devices: { [EditorDraft.key]: draft.json } });
    const action = new SavePage({ day, document });
    const result = decision(action, action.load(read), new IDSource(read.views));
    assert.equal(result.kind, 'write');
    if (result.kind !== 'write') return;
    assert.deepEqual(result.plan.deviceWrites, [
      { key: 'contentClock', value: { ms: stamp.ms, counter: 0 } },
      ...(draftDay === day ? [{ key: EditorDraft.key, value: null }] : []),
    ]);
    assert.deepEqual(read.device(EditorDraft.key), draft.json);
  }
});

test('the editor reads and edits the same receipt when multiple contributions await reconciliation', () => {
  const first = new PendingClaim({ day, claimId: 'claim-a', document: { ...document, body: 'First contribution' } });
  const second = new PendingClaim({ day, claimId: 'claim-z', document: { ...document, body: 'Second contribution' }, retirements: { scales: 'retired' } });
  const read = reader({ devices: { [second.key]: second.json, [first.key]: first.json } });
  const room = new JournalRoom(read);
  assert.equal(room.pages[0]?.document.body, first.latest.body);
  assert.equal(room.state.scales, 'retired');
  const action = new SavePage({ day, document: { ...document, body: 'First contribution edited' } });
  const result = decision(action, action.load(read), new IDSource(read.views));
  assert.equal(result.kind, 'write');
  if (result.kind !== 'write') return;
  assert.deepEqual(result.plan.deviceWrites.map((write) => write.key), [first.key]);
  assert.deepEqual(read.device(first.key), first.json);
  assert.deepEqual(read.device(second.key), second.json);
});
