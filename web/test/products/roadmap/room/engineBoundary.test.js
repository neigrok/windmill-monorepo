// The room reads the sync engine only through its public API (web/src/platform/sync/README.md): no room file reaches
// into the replica, its caches, its subscriptions or its transport.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { transformWithEsbuild } from 'vite';

const PUBLIC = new Set(['observe', 'observeEngine', 'getSnapshot', 'onEvent', 'subscribe', 'unsubscribe', 'commit', 'commitAct', 'undo',
  'requestInverse', 'readInverseResult', 'releaseReversibleAct', 'newGestureId', 'freshness', 'registry']);
const INTERNALS = new Set(['activeReplica', 'confirmedRows', 'loadedCaches', 'openScopes', 'deviceRows', 'cursorOf']);

// Each reach past the API in one source: a member of an `engine` (or `this.engine`) the API does not name, and any
// name of the replica's insides.
async function reaches(name, text) {
  const { code } = await transformWithEsbuild(text, name, { loader: 'jsx' });
  const found = [];
  const isEngine = (node) => (node.type === 'Identifier' && node.name === 'engine')
    || (node.type === 'MemberExpression' && !node.computed && node.property.name === 'engine' && node.object.type === 'ThisExpression');
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'MemberExpression' && !node.computed) {
      if (isEngine(node.object) && !PUBLIC.has(node.property.name)) found.push(`${name}: engine.${node.property.name}`);
      if (INTERNALS.has(node.property.name)) found.push(`${name}: .${node.property.name}`);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
  return found;
}

test('a reach past the engine’s API is found', async () => {
  assert.deepEqual(await reaches('fixture.js', 'export class R { read(engine, s) { return [engine.observe(s), engine.device.activeReplica, this.engine.store]; } }'),
    ['fixture.js: .activeReplica', 'fixture.js: engine.device', 'fixture.js: engine.store']);
});

test('no room file reads the sync engine past its public API', async () => {
  const room = new URL('../../../../src/products/roadmap/room/', import.meta.url);
  const files = readdirSync(room).filter((name) => /\.jsx?$/.test(name)).sort();
  const found = (await Promise.all(files.map((name) => reaches(name, readFileSync(new URL(name, room), 'utf8'))))).flat();
  assert.deepEqual({ read: files.includes('ReplicaReading.js'), found }, { read: true, found: [] });
});
