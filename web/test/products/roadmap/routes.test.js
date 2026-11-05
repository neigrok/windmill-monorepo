import test from 'node:test';
import assert from 'node:assert/strict';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';

const ROUTES = [
  ['a share link', { hash: '#/t/t_shared', pathname: '/', search: '' }],
  ['the /t/ path', { hash: '', pathname: '/t/t_shared', search: '' }],
  ['the demo', { hash: '#/demo', pathname: '/', search: '' }],
];

function withBoardFlag(t, value) {
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => (key === 'windmill:board:dev' ? value : null) };
  t.after(() => { globalThis.localStorage = original; });
}

for (const [name, location] of ROUTES) {
  test(`${name} asks for the room chrome only with the Board's opt-in`, (t) => {
    withBoardFlag(t, null);
    assert.equal(roadmapRoutes.render(location).inRoom, false);
    globalThis.localStorage.getItem = (key) => (key === 'windmill:board:dev' ? '1' : null);
    assert.equal(roadmapRoutes.render(location).inRoom, true);
  });
}

test('a failing read of the opt-in leaves share links outside the room', (t) => {
  withBoardFlag(t, null);
  globalThis.localStorage.getItem = () => { throw new DOMException('denied', 'SecurityError'); };
  assert.equal(roadmapRoutes.render({ hash: '#/t/t_shared', pathname: '/', search: '' }).inRoom, false);
});

test('Planted in public stays outside the room', (t) => {
  withBoardFlag(t, '1');
  assert.equal(roadmapRoutes.render({ hash: '#/browse', pathname: '/', search: '' }).inRoom, undefined);
});
