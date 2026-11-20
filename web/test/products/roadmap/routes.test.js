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

test('a build that sets no switch opens every roadmap room on today\'s reading, has no page of the person\'s roadmaps and asks the shell no question of roadmaps, and only Web Deploy, from the host\'s switch, and the cutover set one', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const rooms = ['#/t/t_shared', '#/demo', '#/app/t_mine'].map((hash) => roadmapRoutes.render({ hash, pathname: '/', search: '' }).props.replica);
  const roadmaps = roadmapRoutes.render({ hash: '#/app/roadmaps', pathname: '/', search: '' }).props;
  const workflows = new URL('../../../../.github/workflows/', import.meta.url);
  const setting = readdirSync(workflows).filter((name) => readFileSync(new URL(name, workflows), 'utf8').includes('VITE_ROADMAP_REPLICA_ROOM'));
  assert.deepEqual({ rooms, roadmaps, path: roadmapRoutes.render({ hash: '', pathname: '/t/t_shared', search: '' }).props.replica, sync: roadmapRoutes.sync, setting },
    { rooms: [false, false, false], roadmaps: { treeId: 'roadmaps', birth: false, start: false, demo: false, replica: false }, path: false, sync: undefined, setting: ['roadmap-cutover.yml', 'web.yml'] });
});
