import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLabel, visibleGroups, keyHint, detectPlatform, SHORTCUT_GROUPS } from '../../../../src/products/roadmap/shortcuts/shortcutMap.js';

test('keyLabel swaps the four platform keys on Windows', () => {
  assert.equal(keyLabel('⌘', 'windows'), 'Ctrl');
  assert.equal(keyLabel('⌥', 'windows'), 'Alt');
  assert.equal(keyLabel('⌫', 'windows'), 'Delete');
  assert.equal(keyLabel('⏎', 'windows'), 'Enter');
});

test('keyLabel leaves shared keys untouched on Windows', () => {
  assert.equal(keyLabel('⇧', 'windows'), '⇧');
  assert.equal(keyLabel('A', 'windows'), 'A');
  assert.equal(keyLabel('esc', 'windows'), 'esc');
  assert.equal(keyLabel('?', 'windows'), '?');
});

test('keyLabel returns every key unchanged on Mac', () => {
  assert.equal(keyLabel('⌘', 'mac'), '⌘');
  assert.equal(keyLabel('⌥', 'mac'), '⌥');
  assert.equal(keyLabel('⌫', 'mac'), '⌫');
  assert.equal(keyLabel('⏎', 'mac'), '⏎');
  assert.equal(keyLabel('A', 'mac'), 'A');
});

test('visibleGroups keeps every group when editable', () => {
  assert.deepEqual(visibleGroups(false).map((group) => group.title), ['Navigate', 'Select', 'Edit', 'History', 'View']);
  assert.equal(visibleGroups(false), SHORTCUT_GROUPS);
});

test('visibleGroups drops editing groups when read-only', () => {
  assert.deepEqual(visibleGroups(true).map((group) => group.title), ['Navigate', 'View']);
});

test('keyHint reads the compact key hint from the shared map', () => {
  assert.equal(keyHint('Keyboard shortcuts'), '?');
  assert.equal(keyHint('Activity feed'), 'A');
  assert.equal(keyHint('Undo'), '⌘Z');
  assert.equal(keyHint('No such row'), '');
});

test('detectPlatform defaults to Mac when no Windows platform is present', () => {
  assert.equal(detectPlatform(), 'mac');
});
