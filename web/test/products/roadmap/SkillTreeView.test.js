import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';
import { boardKey, graphOnlyKey } from '../../../src/products/roadmap/shortcuts/shortcutMap.js';

// Run the host's actual event boundaries with injected collaborators, without starting its WebGL scene.
const source = await readFile(new URL('../../../src/products/roadmap/SkillTreeView.jsx', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source, 'SkillTreeView.jsx', { loader: 'jsx' });
const handlers = new Map();
const visit = (node) => {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && ['onEditorKey', 'onPaste'].includes(node.id.name)) {
    assert.equal(handlers.has(node.id.name), false);
    handlers.set(node.id.name, code.slice(node.init.start, node.init.end));
  }
  if (node.type === 'VariableDeclarator' && node.id.name === 'newStepFromBoard') {
    const callback = node.init.arguments[0];
    handlers.set(node.id.name, code.slice(callback.start, callback.end));
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(visit);
    else if (child && typeof child === 'object') visit(child);
  }
};
visit(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
assert.deepEqual([...handlers.keys()].sort(), ['newStepFromBoard', 'onEditorKey', 'onPaste']);

function host({ gate = true, coveringPage = false, modal = false, pasteComposer = false, typing = false } = {}) {
  const calls = [];
  const scope = {
    BOARD_OPEN: gate,
    boardKey,
    graphOnlyKey,
    boardActiveRef: { current: gate },
    boardSwitchRef: { current: null },
    stepDetailOpenRef: { current: coveringPage },
    composerOpenRef: { current: pasteComposer },
    readOnlyRef: { current: false },
    legendRef: { current: [] },
    document: {
      activeElement: typing ? { tagName: 'INPUT' } : { tagName: 'BUTTON' },
      querySelector: () => modal ? {} : null,
    },
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    setShortcutsOpen: () => calls.push('shortcuts'),
    setDraftKinds: (kinds) => calls.push(['kinds', kinds]),
    setDraft: (text) => calls.push(['draft', text]),
    setComposerOpen: (open) => calls.push(['composer', open]),
  };
  const key = runInNewContext(`(${handlers.get('onEditorKey')})`, scope);
  const paste = runInNewContext(`(${handlers.get('onPaste')})`, scope);
  const event = { preventDefault: () => calls.push('preventDefault') };
  return {
    calls,
    key: (chord) => key({ ...event, ...chord }),
    paste: () => paste({ ...event, clipboardData: { getData: () => 'A sailing plan' } }),
  };
}

for (const coverage of [{ coveringPage: true }, { modal: true }, { pasteComposer: true }]) {
  test(`host shortcuts leave the covered Board alone: ${JSON.stringify(coverage)}`, () => {
    const boundary = host(coverage);
    boundary.key({ key: 'z', metaKey: true });
    boundary.key({ key: 'Z', ctrlKey: true, shiftKey: true });
    boundary.key({ key: '?' });
    boundary.paste();
    assert.deepEqual(boundary.calls, []);
  });
}

test('uncovered Board keeps undo, redo, shortcuts and paste, while typing keeps native paste and help keys', () => {
  const boundary = host();
  boundary.key({ key: 'z', metaKey: true });
  boundary.key({ key: 'Z', ctrlKey: true, shiftKey: true });
  boundary.key({ key: '?' });
  boundary.paste();
  assert.deepEqual(boundary.calls, [
    'preventDefault', 'undo', 'preventDefault', 'redo', 'preventDefault', 'shortcuts',
    'preventDefault', ['kinds', []], ['draft', 'A sailing plan'], ['composer', true],
  ]);
  const typing = host({ typing: true });
  typing.key({ key: '?' });
  typing.paste();
  assert.deepEqual(typing.calls, []);
});

test('the closed Board gate preserves the host shortcut behavior under other layers', () => {
  const boundary = host({ gate: false, coveringPage: true, modal: true });
  boundary.key({ key: 'z', metaKey: true });
  boundary.key({ key: 'Z', ctrlKey: true, shiftKey: true });
  boundary.key({ key: '?' });
  boundary.paste();
  assert.deepEqual(boundary.calls, [
    'preventDefault', 'undo', 'preventDefault', 'redo', 'preventDefault', 'shortcuts',
    'preventDefault', ['kinds', []], ['draft', 'A sailing plan'], ['composer', true],
  ]);
  const pasteComposer = host({ gate: false, pasteComposer: true });
  pasteComposer.paste();
  assert.deepEqual(pasteComposer.calls, []);
});

test('the Board creation verb opens its composer only for the active owner behind the open gate', () => {
  for (const [gate, active, owner] of [[false, true, true], [true, false, true], [true, true, false], [true, true, true]]) {
    const calls = [];
    const open = runInNewContext(`(${handlers.get('newStepFromBoard')})`, {
      BOARD_OPEN: gate,
      boardActive: active,
      owner,
      setBoardComposer: ({ door }) => calls.push(['composer', door]),
      track: (name, { step, door }) => calls.push(['event', name, step, door]),
    });
    open('verbs');
    assert.deepEqual(calls, gate && active && owner ? [
      ['composer', 'verbs'],
      ['event', 'roadmap_board_create', 'open', 'verbs'],
    ] : []);
  }
});
