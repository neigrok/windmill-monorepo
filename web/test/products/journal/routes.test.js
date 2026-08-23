import test from 'node:test';
import assert from 'node:assert/strict';

import { journalRoutes } from '../../../src/products/journal/routes.js';

test('journal registers a settings section, in the data zone beside the account’s own', () => {
  assert.equal(Array.isArray(journalRoutes.settingsSections.data), true);
  assert.equal(journalRoutes.settingsSections.data.length, 1);
  assert.equal(typeof journalRoutes.settingsSections.data[0], 'object');
  assert.equal(journalRoutes.settingsSections.main, undefined, 'the journal contributes nothing to the product zone');
});
