import test from 'node:test';
import assert from 'node:assert/strict';

import { journalRoutes } from '../../../src/products/journal/routes.js';
import { EditorDraft, PendingClaim } from '../../../src/products/journal/domain/writing.js';

test('journal registers a settings section, in the data zone beside the account’s own', () => {
  assert.equal(Array.isArray(journalRoutes.settingsSections.data), true);
  assert.equal(journalRoutes.settingsSections.data.length, 1);
  assert.equal(typeof journalRoutes.settingsSections.data[0], 'object');
  assert.equal(journalRoutes.settingsSections.main, undefined, 'the journal contributes nothing to the product zone');
});

test('journal hands the engine its claim hooks, and a sign-in question counts its pages', () => {
  const { sync } = journalRoutes;
  assert.deepEqual(Object.keys(sync).sort(), ['onPushResult', 'pendingDeviceWork', 'prepare', 'signedOutWork']);
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
