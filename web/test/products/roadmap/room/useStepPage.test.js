import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStepPage } from '../../../../src/products/roadmap/room/useStepPage.js';
import { BoardQuery } from '../../../../src/products/roadmap/board/Board.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';

test('Select closes the page, selects, reveals through the held tree and issues keys that survive a cleared request', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Sailing', nodes: [
    { id: 'course', label: 'Course', color: 'terracotta', prerequisites: [] },
    { id: 'wind', label: 'Wind', color: 'olive', prerequisites: ['course'] },
    { id: 'held', label: 'Held', color: 'terracotta', prerequisites: ['course'] },
  ] });
  const boardTree = tree.without(['held']);
  const calls = [];
  let query = new BoardQuery({ search: 'Course', kinds: ['olive'], sort: 'newest', branch: 'course' });
  let request = null;
  let page;
  function Capture() {
    page = useStepPage({ treeId: tree.treeId, tree, boardTree, loading: false,
      address: { id: 'wind', trail: ['course', 'wind'], close: () => calls.push('close') },
      anchors: { rootRef: { current: null }, identityRef: { current: null }, boardLayerRef: { current: null } },
      view: { canvasView: false }, sceneRef: { current: null },
      setSelectedId: (id) => calls.push(['selected', id]),
      setBoardQuery: (change) => { query = change(query); calls.push('query'); },
      setBoardSelect: (value) => { request = value; calls.push(['request', value]); },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Capture));
  page.select('wind');
  assert.deepEqual(calls, ['close', ['selected', 'wind'], 'query', ['request', { id: 'wind', key: 1 }]]);
  assert.deepEqual(query, new BoardQuery({ search: '', kinds: ['olive'], sort: 'newest', branch: 'course' }));
  assert.deepEqual(request, { id: 'wind', key: 1 });
  request = null;
  page.select('wind');
  assert.deepEqual(request, { id: 'wind', key: 2 });
});
