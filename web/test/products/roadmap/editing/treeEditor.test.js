// `treeData` shares the `nodes` array it is handed — no clone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TreeEditor } from '../../../../src/products/roadmap/editing/TreeEditor.js';

const treeData = (id, nodes) => ({ id, title: 'T', nodes });

test('treeData hands back the very object the editor was built with, not a copy', () => {
  const data = treeData('t1', [{ id: 'a', label: 'A', prerequisites: [] }]);
  const editor = new TreeEditor(data);

  assert.equal(editor.treeData, data);
  assert.equal(editor.treeData.nodes, data.nodes);
  assert.deepEqual(editor.treeData, { id: 't1', title: 'T', nodes: [{ id: 'a', label: 'A', prerequisites: [] }] });
});

test('assigning present is visible through treeData on the next read', () => {
  const first = treeData('t1', []);
  const second = treeData('t1', [{ id: 'a', label: 'A', prerequisites: [] }]);
  const editor = new TreeEditor(first);

  editor.present = second;

  assert.equal(editor.treeData, second);
  assert.deepEqual(editor.treeData, { id: 't1', title: 'T', nodes: [{ id: 'a', label: 'A', prerequisites: [] }] });
});

test('two readers of one editor see the same projection by identity', () => {
  const editor = new TreeEditor(treeData('t1', []));
  const readerA = editor.treeData;

  editor.present = treeData('t1', [{ id: 'a', label: 'A', prerequisites: [] }]);

  assert.notEqual(editor.treeData, readerA);
  assert.equal(editor.treeData, editor.treeData);
});

test('the editor holds nothing but the present — no history lives here', () => {
  const editor = new TreeEditor(treeData('t1', []));

  assert.deepEqual(Object.keys(editor), ['present']);
  assert.deepEqual(
    ['undo', 'redo', 'commit', 'past', 'future'].map((name) => typeof editor[name]),
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
  );
});
