import test from 'node:test';
import assert from 'node:assert/strict';
import { roadmapRoutes } from '../../../src/products/roadmap/routes.js';

for (const [name, location] of [
  ['a share link', { hash: '#/t/t_shared', pathname: '/', search: '' }],
  ['the /t/ path', { hash: '', pathname: '/t/t_shared', search: '' }],
  ['the demo', { hash: '#/demo', pathname: '/', search: '' }],
  ['a roadmap on a path outside /app', { hash: '#/app/t_mine', pathname: '/', search: '' }],
]) {
  test(`${name} asks for the room chrome`, () => {
    assert.equal(roadmapRoutes.render(location).inRoom, true);
  });
}

test('Planted in public stays outside the room', () => {
  assert.equal(roadmapRoutes.render({ hash: '#/browse', pathname: '/', search: '' }).inRoom, undefined);
});
