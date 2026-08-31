import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { NOTES_HREF } from '../../../../src/products/gym/log.js';
import { FULL_LINE } from '../../../../src/products/gym/notes/notes.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, roomLog, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// Save is the design system's Button — a component element in a shallow render, so it is found by
// what it says rather than by a class.
const saveOf = (tree) => elementsOf(tree)
  .find((each) => typeof each.type === 'function' && each.props.children === 'Save');

// The notes wire: GET /notes serves `stored`; a PUT on one note answers from `onSave`.
function notesOnTheWire({ stored = [], onSave }) {
  const wire = [];
  global.fetch = async (url, options = {}) => {
    const path = url.slice(`${API_BASE}/v1/gym`.length);
    const method = options.method ?? 'GET';
    wire.push(`${method} ${path}`);
    if (path === '/notes' && method === 'GET') return { ok: true, status: 200, json: async () => ({ notes: stored }) };
    if (path.startsWith('/notes/') && method === 'PUT') {
      const { status, body } = onSave(JSON.parse(options.body));
      return { ok: status < 300, status, json: async () => body };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return wire;
}

const editorOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteEditor');
const backOf = (tree) => elementsOf(tree).find((each) => typeof each.type === 'function' && each.type.name === 'Back');
const fresh = { id: 'note_0123456789abcdef', title: '', body: '', fresh: true };

function editorWith(t, NoteEditor, note, hooks = {}) {
  const called = { closed: 0, stale: 0, saved: [] };
  const screen = renderHook(t, () => NoteEditor({
    note,
    onClose: () => { called.closed += 1; },
    onSaved: (stored) => called.saved.push(stored),
    onDelete: () => {},
    onStale: () => { called.stale += 1; },
    ...hooks,
  }));
  return { screen, called };
}

test('a pasted sixty-one-character title is taken whole, counted in alarm, and refused in place in the store’s words when saved', async (t) => {
  browserWith();
  const wire = notesOnTheWire({ onSave: () => ({ status: 400, body: { error: 'a title runs to 60 characters' } }) });
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const { screen } = editorWith(t, NoteEditor, fresh);

  const input = findByClass(screen.tree, 'gym-note-title-input')[0];
  assert.equal(input.props.maxLength, undefined, 'nothing truncates a paste');
  input.props.onChange({ target: { value: 't'.repeat(61) } });

  assert.equal(findByClass(screen.tree, 'gym-note-title-input')[0].props.value, 't'.repeat(61));
  const counter = findByClass(screen.tree, 'gym-note-count')[0];
  assert.equal(textOf(counter), '61 of 60 characters');
  assert.equal(counter.props.className.includes('is-over'), true);

  const save = saveOf(screen.tree);
  assert.equal(save.props.disabled, undefined, 'Save stays tappable over the cap');
  save.props.onClick();
  await settle();

  assert.deepEqual(wire, ['PUT /notes/note_0123456789abcdef']);
  assert.equal(textOf(findByClass(screen.tree, 'gym-editor-missing')[0]), 'a title runs to 60 characters');
  assert.notEqual(findByClass(screen.tree, 'gym-note-title-input')[0], undefined, 'the editor stays open with the sentence');
});

test('the counter is drawn from the forty-eighth character and not before', async (t) => {
  browserWith();
  notesOnTheWire({ onSave: () => { throw new Error('nothing saves here'); } });
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const { screen } = editorWith(t, NoteEditor, fresh);
  const type = (value) => findByClass(screen.tree, 'gym-note-title-input')[0].props.onChange({ target: { value } });

  type('t'.repeat(47));
  assert.equal(findByClass(screen.tree, 'gym-note-count').length, 0);
  type('t'.repeat(48));
  assert.equal(textOf(findByClass(screen.tree, 'gym-note-count')[0]), '48 of 60 characters');
  assert.equal(findByClass(screen.tree, 'gym-note-count')[0].props.className.includes('is-over'), false);
});

test('an eleventh note the store refuses leaves the editor open with the sentence, and re-reads the list behind it', async (t) => {
  browserWith();
  const wire = notesOnTheWire({ onSave: () => ({ status: 409, body: { error: FULL_LINE, code: 'notes-full' } }) });
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const { screen, called } = editorWith(t, NoteEditor, fresh);

  findByClass(screen.tree, 'gym-note-title-input')[0].props.onChange({ target: { value: 'Eleventh' } });
  saveOf(screen.tree).props.onClick();
  await settle();

  assert.deepEqual(wire, ['PUT /notes/note_0123456789abcdef']);
  assert.equal(textOf(findByClass(screen.tree, 'gym-editor-missing')[0]), '10 of 10 notes. Delete one to add another.');
  assert.equal(called.stale, 1, 'the list is re-read once');
  assert.equal(called.closed, 0);
  assert.deepEqual(called.saved, []);
});

test('a refusal that is not the full account re-reads nothing', async (t) => {
  browserWith();
  notesOnTheWire({ onSave: () => ({ status: 400, body: { error: 'a note runs to 500 bytes' } }) });
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const { screen, called } = editorWith(t, NoteEditor, fresh);

  findByClass(screen.tree, 'gym-note-title-input')[0].props.onChange({ target: { value: 'Long' } });
  saveOf(screen.tree).props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-editor-missing')[0]), 'a note runs to 500 bytes');
  assert.equal(called.stale, 0);
});

test('the Notes screen re-reads the store when the editor says its list is stale', async (t) => {
  browserWith();
  const wire = notesOnTheWire({ stored: Array.from({ length: 10 }, (_, i) => ({ id: `note_${i}`, position: i, title: `Note ${i}`, body: '', updatedAt: 0 })) });
  const { Notes } = await loadScreen('products/gym/notes/Notes.jsx');
  const screen = renderHook(t, () => Notes({ log: roomLog() }));
  await settle();
  assert.deepEqual(wire, ['GET /notes']);
  assert.equal(findByClass(screen.tree, 'gym-notes-full').length, 1);

  // A note opened from a row; the editor is the screen while it is open.
  const list = elementsOf(screen.tree).find((each) => typeof each.type === 'function' && each.type.name === 'NoteList');
  list.props.onOpen(list.props.notes[3]);
  const editor = editorOf(screen.tree);
  assert.notEqual(editor, undefined);
  editor.props.onStale();
  await settle();
  assert.deepEqual(wire, ['GET /notes', 'GET /notes']);
  assert.notEqual(editorOf(screen.tree), undefined, 'the editor stays open');
});

test('a delete window over the last note does not empty the room: the placeholders read the store, not the drawn rows', async (t) => {
  browserWith();
  const only = { id: 'note_only', position: 0, title: 'How I want to be talked to', body: 'Blunt.', updatedAt: 0 };
  notesOnTheWire({ stored: [only] });
  const { Notes } = await loadScreen('products/gym/notes/Notes.jsx');
  const held = [{ kind: 'note', id: 'note_only', line: 'Note deleted.' }];
  const screen = renderHook(t, () => Notes({ log: roomLog({ held }) }));
  await settle();

  // The row is off the screen for the length of the window — that is what the window is for.
  assert.equal(findByClass(screen.tree, 'gym-note-row').length, 0, 'the held note is off the screen');
  // But the store still holds it, so this is not an account with nothing in it: the onboarding rows
  // would offer to seed a room that is one Undo away from being full of its own note.
  assert.equal(findByClass(screen.tree, 'is-placeholder').length, 0, 'and nothing offers to seed an empty room');
  assert.equal(textOf(screen.tree).includes('What I am training for'), false);
  // The way on is the same one the cap reads: Add, off the store's count.
  assert.equal(textOf(findByClass(screen.tree, 'gym-notes-add')[0]), 'Add a note');
  assert.equal(findByClass(screen.tree, 'gym-notes-full').length, 0);

  // With nothing stored at all, the placeholders are exactly what the room draws.
  notesOnTheWire({ stored: [] });
  const empty = renderHook(t, () => Notes({ log: roomLog() }));
  await settle();
  assert.deepEqual(
    findByClass(empty.tree, 'is-placeholder').map(textOf),
    ['How I want to be talked to', 'What I am training for'],
  );
});

test('the editor’s delete is one press and hands the whole note up: no question, and nothing sent from here', async (t) => {
  browserWith();
  const wire = notesOnTheWire({});
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const stored = { id: 'note_0123456789abcdef', title: 'Kept', body: '', fresh: false };
  const handed = [];
  const { screen } = editorWith(t, NoteEditor, stored, { onDelete: (note) => handed.push(note) });

  assert.equal(findByClass(screen.tree, 'gym-confirm').length, 0);
  assert.equal(textOf(findByClass(screen.tree, 'gym-note-delete')[0]), 'Delete note');
  findByClass(screen.tree, 'gym-note-delete')[0].props.onClick();
  await settle();
  assert.deepEqual(handed, [stored], 'the room withholds it; the editor sends nothing');
  assert.deepEqual(wire.filter((line) => line.startsWith('DELETE')), []);

  // A note that was never stored has nothing to delete.
  const { screen: minting } = editorWith(t, NoteEditor, fresh);
  assert.equal(findByClass(minting.tree, 'gym-note-delete').length, 0);
});

test('the editor’s back is the one Back link, pointing at the notes list, and closes the editor without leaving the hash', async (t) => {
  browserWith();
  notesOnTheWire({});
  const { NoteEditor } = await loadScreen('products/gym/notes/Notes.jsx');
  const { screen, called } = editorWith(t, NoteEditor, { ...fresh, fresh: false, title: 'Kept' });

  const back = backOf(screen.tree);
  assert.notEqual(back, undefined);
  assert.equal(back.props.href, NOTES_HREF);
  assert.equal(back.props.children, 'Notes');
  assert.equal(findByClass(screen.tree, 'gym-back').length, 0, 'no hand-rolled back beside it');

  let prevented = 0;
  back.props.onClick({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(called.closed, 1);
});
