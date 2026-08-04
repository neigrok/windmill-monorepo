// Light or dark is chosen once, for the whole app. These pin the rules that decide what a surface
// actually wears — the part that is pure, and therefore the part that can be wrong quietly.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_CHOICES, readAppearance, resolveAppearance, systemAppearance,
} from '../../src/shell/appearance.js';

test('the three choices are exactly light, dark and system', () => {
  assert.deepEqual(APPEARANCE_CHOICES, ['light', 'dark', 'system']);
});

// "System" is not a third palette — it is the absence of a choice. Resolving it to a fixed value
// would pin the app to whatever it was the first time someone looked.
test('system resolves to whatever the device says, and nothing else does', () => {
  assert.equal(resolveAppearance('system', 'dark'), 'dark');
  assert.equal(resolveAppearance('system', 'light'), 'light');
  assert.equal(resolveAppearance('dark', 'light'), 'dark', 'an explicit choice ignores the device');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
});

// The module is imported by the shell on first paint, so it has to survive a place with no
// localStorage and no matchMedia (a private window that refuses storage, SSR, this test).
test('with no browser around it falls back rather than throwing', () => {
  assert.equal(readAppearance(), 'system');
  assert.equal(systemAppearance(), 'light');
  assert.equal(resolveAppearance(), 'light');
});
