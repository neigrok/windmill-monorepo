// The per-step workspace — sub-tasks, one note, saved links — is a pure workspace → workspace
// module, and the arc behind every node in the scene is read straight off it. The next wave lifts
// the calls into ui/tree/useWorkspace.js, so the two properties that must survive that move are
// pinned here on every op: the input workspace comes back untouched, and a rejected edit returns
// the SAME workspace object rather than an equal copy (the panel leans on that identity to skip a
// save round-trip on a no-op keystroke).
//
// parseLink is not exported, so its rules are pinned through addLink, which is the only door to it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyWorkspace,
  addSubtask,
  toggleSubtask,
  editSubtask,
  deleteSubtask,
  setNote,
  addLink,
  deleteLink,
  arcFraction,
} from '../../../../src/products/roadmap/model/NodeWorkspace.js';

// A workspace with three sub-tasks under known ids — addSubtask mints random ones, so the ops
// under test get a fixture whose ids a full assertion can name.
function threeTasks() {
  return {
    subtasks: [
      { id: 's1', label: 'Draft', done: false },
      { id: 's2', label: 'Review', done: true },
      { id: 's3', label: 'Ship', done: false },
    ],
    note: 'the note',
    links: [{ id: 'l1', url: 'https://example.com/', title: 'example.com', domain: 'example.com' }],
  };
}

function pure(before, input, output) {
  assert.deepEqual(input, before, 'the op mutated the workspace it was given');
  assert.notEqual(output, input, 'the op returned the same workspace instead of a new one');
}

test('an empty workspace is three empty fields, freshly allocated each time', () => {
  assert.deepEqual(emptyWorkspace(), { subtasks: [], note: '', links: [] });
  // two nodes opened in a row must not share one array
  assert.notEqual(emptyWorkspace().subtasks, emptyWorkspace().subtasks);
  assert.notEqual(emptyWorkspace().links, emptyWorkspace().links);
});

test('addSubtask trims the label and appends an undone task', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const next = addSubtask(ws, '   Pack the boxes \n ');

  assert.deepEqual(next.subtasks.slice(0, 3), before.subtasks);
  assert.deepEqual(
    { label: next.subtasks[3].label, done: next.subtasks[3].done },
    { label: 'Pack the boxes', done: false },
  );
  assert.ok(typeof next.subtasks[3].id === 'string' && next.subtasks[3].id.length > 0);
  assert.deepEqual({ note: next.note, links: next.links }, { note: before.note, links: before.links });
  pure(before, ws, next);
});

test('addSubtask rejects a whitespace-only label by handing back the very same workspace', () => {
  const ws = threeTasks();

  assert.equal(addSubtask(ws, ''), ws);
  assert.equal(addSubtask(ws, '   '), ws);
  assert.equal(addSubtask(ws, '\n\t '), ws);
  assert.deepEqual(ws, threeTasks());
});

test('toggleSubtask flips exactly one task, and flips it back', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const toggled = toggleSubtask(ws, 's1');

  assert.deepEqual(toggled, {
    subtasks: [
      { id: 's1', label: 'Draft', done: true },
      { id: 's2', label: 'Review', done: true },
      { id: 's3', label: 'Ship', done: false },
    ],
    note: 'the note',
    links: before.links,
  });
  assert.deepEqual(toggleSubtask(toggled, 's1'), before);
  pure(before, ws, toggled);
});

test('toggleSubtask for an id that is not there leaves every task as it was', () => {
  const ws = threeTasks();
  const toggled = toggleSubtask(ws, 'ghost');

  assert.deepEqual(toggled, threeTasks());
  pure(structuredClone(ws), ws, toggled);
});

test('editSubtask trims and renames only the named task', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const edited = editSubtask(ws, 's2', '  Review with Ana  ');

  assert.deepEqual(edited, {
    subtasks: [
      { id: 's1', label: 'Draft', done: false },
      { id: 's2', label: 'Review with Ana', done: true },
      { id: 's3', label: 'Ship', done: false },
    ],
    note: 'the note',
    links: before.links,
  });
  pure(before, ws, edited);
});

test('editSubtask refuses to blank a label, handing back the very same workspace', () => {
  const ws = threeTasks();

  assert.equal(editSubtask(ws, 's2', ''), ws);
  assert.equal(editSubtask(ws, 's2', '    '), ws);
  assert.deepEqual(ws, threeTasks());
});

test('deleteSubtask removes exactly the named task', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const deleted = deleteSubtask(ws, 's2');

  assert.deepEqual(deleted, {
    subtasks: [
      { id: 's1', label: 'Draft', done: false },
      { id: 's3', label: 'Ship', done: false },
    ],
    note: 'the note',
    links: before.links,
  });
  assert.deepEqual(deleteSubtask(ws, 'ghost'), before);
  pure(before, ws, deleted);
});

test('setNote replaces the note and shares the untouched arrays', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const noted = setNote(ws, '# Heading\n\nbody');

  assert.deepEqual(noted, { subtasks: before.subtasks, note: '# Heading\n\nbody', links: before.links });
  // structural sharing: the arrays are the same objects, only the wrapper is new
  assert.equal(noted.subtasks, ws.subtasks);
  assert.equal(noted.links, ws.links);
  assert.deepEqual(setNote(ws, ''), { subtasks: before.subtasks, note: '', links: before.links });
  pure(before, ws, noted);
});

test('addLink prepends https:// to a bare host and titles it by the domain', () => {
  const ws = emptyWorkspace();
  const before = structuredClone(ws);

  const next = addLink(ws, '  example.com/docs  ');

  assert.equal(next.links.length, 1);
  assert.deepEqual(
    { url: next.links[0].url, title: next.links[0].title, domain: next.links[0].domain },
    { url: 'https://example.com/docs', title: 'example.com', domain: 'example.com' },
  );
  assert.ok(typeof next.links[0].id === 'string' && next.links[0].id.length > 0);
  pure(before, ws, next);
});

test('addLink strips www. from the domain but keeps the url as it was typed', () => {
  const next = addLink(emptyWorkspace(), 'https://www.example.com/a?b=1#c');

  assert.deepEqual(
    { url: next.links[0].url, title: next.links[0].title, domain: next.links[0].domain },
    { url: 'https://www.example.com/a?b=1#c', title: 'example.com', domain: 'example.com' },
  );
});

test('addLink keeps a non-https scheme it was given', () => {
  const next = addLink(emptyWorkspace(), 'http://localhost:8088/tree');

  assert.deepEqual(
    { url: next.links[0].url, title: next.links[0].title, domain: next.links[0].domain },
    { url: 'http://localhost:8088/tree', title: 'localhost', domain: 'localhost' },
  );
});

test('addLink appends to the links already saved', () => {
  const ws = threeTasks();
  const next = addLink(ws, 'windmill.dev');

  assert.deepEqual(next.links[0], threeTasks().links[0]);
  assert.deepEqual(next.links[1].domain, 'windmill.dev');
  assert.equal(next.links.length, 2);
});

test('addLink of a string that is not a url hands back the very same workspace', () => {
  const ws = threeTasks();

  assert.equal(addLink(ws, 'not a url'), ws);
  assert.equal(addLink(ws, ''), ws);
  assert.equal(addLink(ws, '   '), ws);
  assert.equal(addLink(ws, '::::'), ws);
  assert.deepEqual(ws, threeTasks());
});

test('deleteLink removes exactly the named link', () => {
  const ws = threeTasks();
  const before = structuredClone(ws);

  const deleted = deleteLink(ws, 'l1');

  assert.deepEqual(deleted, { subtasks: before.subtasks, note: 'the note', links: [] });
  assert.deepEqual(deleteLink(ws, 'ghost'), before);
  pure(before, ws, deleted);
});

test('arcFraction is null with no sub-tasks — no gauge is drawn at all', () => {
  assert.equal(arcFraction(emptyWorkspace()), null);
  assert.equal(arcFraction({ subtasks: [], note: 'x', links: [] }), null);
});

test('arcFraction is done over total once there are sub-tasks', () => {
  assert.equal(arcFraction(threeTasks()), 1 / 3);
  assert.equal(arcFraction({ subtasks: [{ id: 'a', label: 'a', done: false }] }), 0);
  assert.equal(arcFraction({ subtasks: [{ id: 'a', label: 'a', done: true }] }), 1);
  assert.equal(
    arcFraction({
      subtasks: [
        { id: 'a', label: 'a', done: true },
        { id: 'b', label: 'b', done: false },
        { id: 'c', label: 'c', done: true },
        { id: 'd', label: 'd', done: true },
      ],
    }),
    0.75,
  );
});
