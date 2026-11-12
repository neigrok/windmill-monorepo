import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoomKey, handleRoomPaste } from '../../../../src/products/roadmap/shortcuts/useRoadmapKeys.js';

function room(t, { covered = false, typing = false, field = typing, boardActive = true, activityEnabled = true, canTend = false, tendOpen = false, findable = true, deleted = true, switches = true } = {}) {
  const calls = [];
  const realDocument = globalThis.document;
  globalThis.document = { activeElement: typing ? { tagName: field ? 'INPUT' : 'DIV', isContentEditable: !field } : { tagName: 'BUTTON' } };
  t.after(() => { globalThis.document = realDocument; });
  const act = (name) => (...args) => { calls.push(args.length ? [name, ...args] : name); };
  const state = {
    canTend, tendOpen, desktopEditor: true, boardActive, activityEnabled,
    covered: () => covered,
    setTendOpen: (value) => calls.push(['tend', typeof value === 'function' ? value(false) : value]),
    openActivity: act('activity'),
    undo: act('undo'), redo: act('redo'), selectEveryStep: act('selectEveryStep'), stepBack: act('stepBack'),
    focusFind: () => { calls.push('find'); return findable; },
    switchViews: switches ? act('switch') : null,
    focusCamera: act('focusCamera'), showAllSteps: act('showAllSteps'), toggleShortcuts: act('shortcuts'),
    deleteSelection: () => { calls.push('deleteSelection'); return deleted; },
    openComposer: act('composer'),
  };
  const event = (chord) => ({ preventDefault: () => calls.push('preventDefault'), ...chord });
  return {
    calls,
    key: (chord) => handleRoomKey(event(chord), state),
    paste: () => handleRoomPaste(event({ clipboardData: { getData: () => 'A sailing plan' } }), state),
  };
}

test('covered: undo, redo, help and paste leave whatever is covering the room alone', (t) => {
  const covered = room(t, { covered: true });
  covered.key({ key: 'z', metaKey: true });
  covered.key({ key: 'Z', ctrlKey: true, shiftKey: true });
  covered.key({ key: '?' });
  covered.key({ key: 'Escape' });
  covered.paste();
  assert.deepEqual(covered.calls, []);
});

test('covered: no key reaches the room beneath, on the Graph or the Board, with focus on a button of whatever covers it', (t) => {
  for (const boardActive of [false, true]) {
    const covered = room(t, { covered: true, boardActive });
    for (const chord of [
      { key: 'Backspace' }, { key: 'Delete' }, { key: 'a', metaKey: true }, { key: 'f' }, { key: '0' },
      { key: '/' }, { key: 'g' }, { key: 'a' }, { key: 'Escape' }, { key: '?' }, { key: 'z', metaKey: true },
    ]) covered.key(chord);
    assert.deepEqual(covered.calls, [], boardActive ? 'board' : 'graph');
  }
});

test('an uncovered Board keeps undo, redo, shortcuts and paste, while typing keeps native paste and help keys', (t) => {
  const open = room(t);
  open.key({ key: 'z', metaKey: true });
  open.key({ key: 'Z', ctrlKey: true, shiftKey: true });
  open.key({ key: '?' });
  open.paste();
  assert.deepEqual(open.calls, [
    'preventDefault', 'undo', 'preventDefault', 'redo', 'preventDefault', 'shortcuts',
    'preventDefault', ['composer', 'A sailing plan'],
  ]);
  const typing = room(t, { typing: true });
  typing.key({ key: '?' });
  typing.paste();
  assert.deepEqual(typing.calls, []);
});

test('the Graph\'s own keys do nothing on the Board, and ⌘A leaves the page\'s selection alone there', (t) => {
  for (const key of ['Backspace', 'Delete', 'a', 'f', 'F', '0']) {
    const board = room(t, { activityEnabled: false });
    board.key({ key });
    assert.deepEqual(board.calls, []);
  }
  const board = room(t);
  board.key({ key: 'a', metaKey: true });
  assert.deepEqual(board.calls, ['preventDefault']);
  const typing = room(t, { typing: true });
  typing.key({ key: 'a', metaKey: true });
  assert.deepEqual(typing.calls, []);
});

test('A opens Activity on either view and yields to a covering layer, typing and readers', (t) => {
  for (const boardActive of [true, false]) {
    const boundary = room(t, { boardActive });
    boundary.key({ key: 'a' });
    boundary.key({ key: 'A' });
    assert.deepEqual(boundary.calls, ['preventDefault', ['activity', 'key'], 'preventDefault', ['activity', 'key']]);
  }
  for (const options of [{ covered: true }, { typing: true }, { activityEnabled: false }]) {
    const inactive = room(t, options);
    inactive.key({ key: 'a' });
    assert.deepEqual(inactive.calls, []);
  }
});

test('on the Graph the camera keys, select all and delete act, each only when nothing is being typed', (t) => {
  const graph = room(t, { boardActive: false });
  for (const chord of [{ key: 'f' }, { key: '0' }, { key: 'a', metaKey: true }, { key: 'Backspace' }, { key: 'Delete' }, { key: 'Escape' }]) graph.key(chord);
  assert.deepEqual(graph.calls, [
    'preventDefault', 'focusCamera', 'preventDefault', 'showAllSteps', 'preventDefault', 'selectEveryStep',
    'deleteSelection', 'preventDefault', 'deleteSelection', 'preventDefault', 'stepBack',
  ]);
  const typing = room(t, { boardActive: false, typing: true });
  for (const chord of [{ key: 'f' }, { key: '0' }, { key: 'a', metaKey: true }, { key: 'Backspace' }]) typing.key(chord);
  assert.deepEqual(typing.calls, []);
  const editable = room(t, { boardActive: false, typing: true, field: false });
  editable.key({ key: 'Delete' });
  assert.deepEqual(editable.calls, ['deleteSelection', 'preventDefault']);
  const nothing = room(t, { boardActive: false, deleted: false });
  nothing.key({ key: 'Delete' });
  assert.deepEqual(nothing.calls, ['deleteSelection']);
});

test('/ finds and G switches on either view, each only when it can', (t) => {
  for (const boardActive of [true, false]) {
    const open = room(t, { boardActive });
    open.key({ key: '/' });
    open.key({ key: 'g' });
    assert.deepEqual(open.calls, ['find', 'preventDefault', 'preventDefault', 'switch']);
  }
  const unable = room(t, { findable: false, switches: false });
  unable.key({ key: '/' });
  unable.key({ key: 'g' });
  assert.deepEqual(unable.calls, ['find']);
});

test('⌘K toggles Ask AI where it can, Escape closes it first, and a key already handled goes no further', (t) => {
  const tending = room(t, { canTend: true });
  tending.key({ key: 'k', metaKey: true });
  assert.deepEqual(tending.calls, ['preventDefault', ['tend', true]]);
  const open = room(t, { canTend: true, tendOpen: true });
  open.key({ key: 'Escape' });
  assert.deepEqual(open.calls, ['preventDefault', ['tend', false]]);
  const covered = room(t, { canTend: true, covered: true });
  covered.key({ key: 'k', metaKey: true });
  assert.deepEqual(covered.calls, []);
  const off = room(t);
  off.key({ key: 'k', metaKey: true });
  assert.deepEqual(off.calls, []);
  const handled = room(t);
  handled.key({ key: 'z', metaKey: true, defaultPrevented: true });
  assert.deepEqual(handled.calls, []);
});

test('in a text field ⌘Z and ⇧⌘Z belong to the field', (t) => {
  for (const [field, boardActive] of [[true, true], [false, true], [true, false]]) {
    const typing = room(t, { typing: true, field, boardActive });
    typing.key({ key: 'z', metaKey: true });
    typing.key({ key: 'Z', metaKey: true, shiftKey: true });
    typing.key({ key: 'z', ctrlKey: true });
    assert.deepEqual(typing.calls, []);
  }
});
