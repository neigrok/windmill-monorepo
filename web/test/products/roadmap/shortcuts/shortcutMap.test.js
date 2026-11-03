import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLabel, visibleGroups, keyHint, detectPlatform, graphOnlyKey, boardKey, SHORTCUT_GROUPS, BOARD_SHORTCUT_GROUPS } from '../../../../src/products/roadmap/shortcuts/shortcutMap.js';

test('Board groups follow the drawn order and the reader has only navigation and help', () => {
  assert.equal(visibleGroups(false, 'board'), BOARD_SHORTCUT_GROUPS);
  const rows = (readOnly) => visibleGroups(readOnly, 'board').map(({ title, rows }) => ({
    title, rows: rows.map(({ label, chords }) => [label, chords.map((chord) => chord.map(({ label }) => label))]),
  }));
  assert.deepEqual(rows(false), [
    { title: 'Board', rows: [
      ['Find a step', [['/']]], ['Move between steps', [['↑', '↓']]],
      ['Move between columns', [['←', '→']]], ['Open step', [['⏎']]],
      ['Close step', [['esc']]], ['Complete step', [['C']]], ['Delete step', [['⌫']]],
      ['Board / Graph', [['G']]],
    ] },
    { title: 'Edit', rows: [['Ask AI', [['⌘', 'K']]], ['Paste a plan', [['⌘', 'V']]]] },
    { title: 'History', rows: [['Undo', [['⌘', 'Z']]], ['Redo', [['⇧', '⌘', 'Z']]]] },
    { title: 'View', rows: [['Keyboard shortcuts', [['?']]]] },
  ]);
  assert.deepEqual(rows(true), [
    { title: 'Board', rows: [
      ['Find a step', [['/']]], ['Move between steps', [['↑', '↓']]],
      ['Move between columns', [['←', '→']]], ['Open step', [['⏎']]],
      ['Close step', [['esc']]], ['Board / Graph', [['G']]],
    ] },
    { title: 'View', rows: [['Keyboard shortcuts', [['?']]]] },
  ]);
});

test('Board delete is unmodified and yields to typing and every covering layer', () => {
  for (const key of ['Backspace', 'Delete']) {
    assert.equal(boardKey({ key }), 'delete');
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) assert.equal(boardKey({ key, [modifier]: true }), null);
    assert.deepEqual([
      boardKey({ key }, { typing: true }), boardKey({ key }, { covered: true }),
    ], [null, null]);
  }
});

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

test('graphOnlyKey — select all, delete, the activity feed, Focus and All steps belong to the Graph; the rest pass to the Board', () => {
  const keys = [
    [{ key: 'a', metaKey: true }, true],
    [{ key: 'A', ctrlKey: true }, true],
    [{ key: 'Backspace' }, true],
    [{ key: 'Delete' }, true],
    [{ key: 'Backspace', metaKey: true }, true],
    [{ key: 'a' }, true],
    [{ key: 'f' }, true],
    [{ key: 'F' }, true],
    [{ key: '0' }, true],
    [{ key: 'A' }, false],
    [{ key: 'f', altKey: true }, false],
    [{ key: 'z', metaKey: true }, false],
    [{ key: 'Escape' }, false],
    [{ key: '?' }, false],
    [{ key: 'k', metaKey: true }, false],
  ];
  assert.deepEqual(keys.map(([event]) => graphOnlyKey(event)), keys.map(([, graphOnly]) => graphOnly));
});

test('boardKey — / finds, G switches and C completes, unmodified and never while typing in a field; ⌘K stays Ask AI', () => {
  const keys = [
    [{ key: '/' }, false, 'find'],
    [{ key: 'g' }, false, 'switch'],
    [{ key: 'G' }, false, 'switch'],
    [{ key: 'c' }, false, 'complete'],
    [{ key: 'C' }, false, 'complete'],
    [{ key: 'c' }, true, null],
    [{ key: 'c', ctrlKey: true }, false, null],
    [{ key: 'c', metaKey: true }, false, null],
    [{ key: 'c', altKey: true }, false, null],
    [{ key: '/' }, true, null],
    [{ key: 'g' }, true, null],
    [{ key: '/', metaKey: true }, false, null],
    [{ key: 'g', ctrlKey: true }, false, null],
    [{ key: 'g', altKey: true }, false, null],
    [{ key: 'k', metaKey: true }, false, null],
    [{ key: 'f' }, false, null],
  ];
  assert.deepEqual(keys.map(([event, typing]) => boardKey(event, { typing })), keys.map(([, , action]) => action));
  assert.deepEqual([boardKey({ key: '/' }, { covered: true }), boardKey({ key: 'g' }, { covered: true }), boardKey({ key: 'c' }, { covered: true })], [null, null, null]);
});

test('boardKey — Share open over the Board is a modal layer, so / and G stand aside while it is', async () => {
  const { register } = await import('node:module');
  register('../../../jsxLoader.mjs', import.meta.url);
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ShareDialog } = await import('../../../../src/products/roadmap/share/ShareDialog.jsx');
  const [held, heldDocument] = [globalThis.window, globalThis.document];
  globalThis.window = { location: { origin: 'https://windmill.works' } };
  globalThis.document = { activeElement: null };
  try {
    const share = (open) => renderToStaticMarkup(React.createElement(ShareDialog, { open, treeId: 't_sail', visibility: 'public', mine: true, onClose() {} }));
    const covered = (markup) => markup.includes('aria-modal="true"');
    assert.deepEqual(
      [true, false].map((open) => [boardKey({ key: '/' }, { covered: covered(share(open)) }), boardKey({ key: 'g' }, { covered: covered(share(open)) })]),
      [[null, null], ['find', 'switch']],
    );
  } finally {
    globalThis.window = held;
    globalThis.document = heldDocument;
  }
});

test('gated Graph groups move slash to Find without changing the legacy or Board groups', () => {
  const groups = visibleGroups(false, 'graph', true);
  const expected = SHORTCUT_GROUPS.map((group) => {
    if (group.title === 'Navigate') return { ...group, rows: [...group.rows,
      { label: 'Find a step', chords: [[{ kind: 'key', label: '/' }]] },
    ] };
    if (group.title === 'Edit') return { ...group, rows: group.rows.map((row) => row.label === 'Ask AI'
      ? { label: 'Ask AI', chords: [[{ kind: 'key', label: '⌘' }, { kind: 'key', label: 'K' }]] }
      : row) };
    return group;
  });
  assert.deepEqual(groups, expected);
  assert.deepEqual(visibleGroups(true, 'graph', true), expected.filter(({ title }) => title === 'Navigate' || title === 'View'));
  assert.equal(visibleGroups(false, 'graph', false), SHORTCUT_GROUPS);
  assert.equal(visibleGroups(false, 'board', true), BOARD_SHORTCUT_GROUPS);
  assert.deepEqual(visibleGroups(true, 'board', true), visibleGroups(true, 'board', false));
});


test('boardKey gives Activity one unmodified owner-neutral key result for host capability checks', () => {
  assert.deepEqual(['a', 'A'].map((key) => boardKey({ key })), ['activity', 'activity']);
  for (const guard of [{ typing: true }, { covered: true }]) {
    assert.equal(boardKey({ key: 'a' }, guard), null);
  }
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) {
    assert.equal(boardKey({ key: 'a', [modifier]: true }), null);
  }
});
