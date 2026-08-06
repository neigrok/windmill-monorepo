// The journal's seam into the neutral settings page. GET /v1/journal/export was live and
// journalApi.exportAll() was written against it, but no product registered a section — so nothing
// in the UI could reach it and a writer could not get their pages out. This pins the registration
// rather than the words, because the registration is the part that silently disappears.

import test from 'node:test';
import assert from 'node:assert/strict';

import { journalRoutes } from '../../../src/products/journal/routes.js';

test('journal registers a settings section, in the data zone beside the account’s own', () => {
  assert.equal(Array.isArray(journalRoutes.settingsSections.data), true);
  assert.equal(journalRoutes.settingsSections.data.length, 1);
  assert.equal(typeof journalRoutes.settingsSections.data[0], 'object');
  assert.equal(journalRoutes.settingsSections.main, undefined, 'the journal contributes nothing to the product zone');
});
