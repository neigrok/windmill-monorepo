import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_CHOICES, readAppearance, resolveAppearance, systemAppearance,
} from '../../src/shell/appearance.js';

test('the three choices are exactly light, dark and system', () => {
  assert.deepEqual(APPEARANCE_CHOICES, ['light', 'dark', 'system']);
});

test('system resolves to whatever the device says, and nothing else does', () => {
  assert.equal(resolveAppearance('system', 'dark'), 'dark');
  assert.equal(resolveAppearance('system', 'light'), 'light');
  assert.equal(resolveAppearance('dark', 'light'), 'dark', 'an explicit choice ignores the device');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
});

test('with no browser around it falls back rather than throwing', () => {
  assert.equal(readAppearance(), 'system');
  assert.equal(systemAppearance(), 'light');
  assert.equal(resolveAppearance(), 'light');
});
