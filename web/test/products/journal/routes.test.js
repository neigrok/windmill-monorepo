import test from 'node:test';
import assert from 'node:assert/strict';

import { journalRoutes } from '../../../src/products/journal/routes.js';
import { EditorDraft, PendingClaim } from '../../../src/products/journal/domain/writing.js';
import { registry } from '../../../src/platform/sync/schema.js';

test('journal registers a settings section, in the data zone beside the account’s own', () => {
  assert.equal(Array.isArray(journalRoutes.settingsSections.data), true);
  assert.equal(journalRoutes.settingsSections.data.length, 1);
  assert.equal(typeof journalRoutes.settingsSections.data[0], 'object');
  assert.equal(journalRoutes.settingsSections.main, undefined, 'the journal contributes nothing to the product zone');
});

test('journal hands the engine its claim hooks, and a sign-in question counts its pages', () => {
  const { sync } = journalRoutes;
  assert.deepEqual(Object.keys(sync).sort(), ['adoptDeviceRows', 'adoptionAnswer', 'adoptionCount', 'onPushResult', 'pendingDeviceWork', 'prepare', 'signedOutWork']);
  const document = { body: 'words', mood: null, energy: null, source: 'typed' };
  const pending = new PendingClaim({ day: '2026-10-01', claimId: 'c1', document });
  pending.edit({ ...document, body: 'later words' });
  const rows = {
    'pendingClaim:c1': pending.json,
    'pendingClaim:c2': new PendingClaim({ day: '2026-10-01', claimId: 'c2', document }).json,
    [EditorDraft.key]: new EditorDraft({ day: '2026-10-01', document }).json,
    contentClock: { ms: 1, counter: 0 },
  };
  assert.deepEqual(sync.pendingDeviceWork('journal', rows), [EditorDraft.key, 'pendingClaim:c1']);
  assert.deepEqual(sync.pendingDeviceWork('gym', rows), []);
  assert.deepEqual(sync.signedOutWork, { type: 'page', one: 'page', many: 'pages' });
});

test('only unwritten journal work is adopted without a personal-data question', () => {
  const day = '2026-10-01';
  const blank = { body: ' \n\u00a0\ufeff', mood: 0, energy: 10, source: 'spoken' };
  const written = { ...blank, body: 'Kept words' };
  const draft = new EditorDraft({ day, document: written });
  const cases = [
    { devices: {}, answer: 'add' },
    { devices: { 'pendingClaim:blank': new PendingClaim({ day, claimId: 'blank', document: blank }).json }, answer: 'add' },
    { devices: { 'pendingClaim:written': new PendingClaim({ day, claimId: 'written', document: written }).json }, answer: null },
    { devices: { [EditorDraft.key]: draft.json }, answer: null },
    { devices: { [draft.recoveryKey]: draft.json }, answer: null },
    { devices: {
      'pendingClaim:blank': new PendingClaim({ day: '2026-09-30', claimId: 'blank', document: blank }).json,
      'pendingClaim:written': new PendingClaim({ day, claimId: 'written', document: written }).json,
      [EditorDraft.key]: draft.json,
    }, answer: null },
  ];
  for (const { devices, answer } of cases) {
    const snapshot = { drawn: [], stored: [], notices: [], firstPullComplete: true };
    const engine = { registry, now: () => Date.parse(`${day}T12:00:00Z`), activeReplica: () => 'replica',
      readMetadata: () => ({ devices, confirmed: new Map(), firstPullComplete: true, commands: [],
        actor: 'writer', isAnonymous: true, checkpoint: { epoch: null, cleanSeq: null } }),
      observe: () => ({ getSnapshot: () => snapshot }), device: { activeReplica: {
        meta: { state: 'anon', serverOffsetMs: 0 }, deviceRows: () => devices, confirmedRow: () => null,
      } } };
    assert.equal(journalRoutes.sync.adoptionAnswer(engine), answer);
    assert.equal(journalRoutes.sync.adoptionCount(engine), answer === 'add' ? 0 : 1);
  }
});
