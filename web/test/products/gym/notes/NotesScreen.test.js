import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../../src/shell/apiBase.js';
import { NOTES_HREF } from '../../../../src/products/gym/log.js';
import { FULL_LINE } from '../../../../src/products/gym/notes/notes.js';
import { browserWith, elementsOf, findByClass, loadScreen, renderHook, settle, textOf } from '../harness.mjs';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

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
    onDeleted: () => {},
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

  const save = findByClass(screen.tree, 'gym-editor-save')[0];
  assert.equal(save.props.className.includes('is-inert'), false, 'Save stays tappable over the cap');
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
  findByClass(screen.tree, 'gym-editor-save')[0].props.onClick();
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
  findByClass(screen.tree, 'gym-editor-save')[0].props.onClick();
  await settle();
  assert.equal(textOf(findByClass(screen.tree, 'gym-editor-missing')[0]), 'a note runs to 500 bytes');
  assert.equal(called.stale, 0);
});

test('the Notes screen re-reads the store when the editor says its list is stale', async (t) => {
  browserWith();
  const wire = notesOnTheWire({ stored: Array.from({ length: 10 }, (_, i) => ({ id: `note_${i}`, position: i, title: `Note ${i}`, body: '', updatedAt: 0 })) });
  const { Notes } = await loadScreen('products/gym/notes/Notes.jsx');
  const screen = renderHook(t, () => Notes({ log: { say: () => {} } }));
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
