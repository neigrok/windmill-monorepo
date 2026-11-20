import test from 'node:test';
import assert from 'node:assert/strict';
import { createTree, deleteTree, renameTree, setGuide, setVisibility } from '../../../../src/products/roadmap/persistence/TreeRegistry.js';
import { buildRetirement } from '../../../../src/products/roadmap/sync/retirement.js';
import { AuthError } from '../../../../src/shell/auth/AuthClient.js';

// The build's retirement is one fact for the page, so these run in order in a process of their own: once retired, it stays.
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function answer(status, body) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, method: init.method, credentials: init.credentials });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const failure = (error) => ({ type: error.constructor.name, message: error.message, code: error.code, status: error.status });
const UNREACHABLE = { type: 'AuthError', message: 'Network request failed', code: 'unreachable', status: 0 };

test('a 410 that is not the retired answer stays the door’s own refusal and retires nothing', async () => {
  answer(410, { error: 'Gone for good.', code: 'id-retired' });
  const error = await setVisibility('t_sail', 'public').catch((thrown) => thrown);
  assert.ok(error instanceof AuthError);
  assert.deepEqual(failure(error), { type: 'AuthError', message: 'Could not change visibility', code: 'id-retired', status: 410 });
  assert.equal(buildRetirement.retired, null);
});

test('the exact retired answer from a write route retires the build, and the door answers as a request that never arrived', async () => {
  const calls = answer(410, { error: 'This version of the app can no longer save; update it.', code: 'client-update-required' });
  const error = await createTree({ id: 't_0123456789abcdef', title: 'Sail' }).catch((thrown) => thrown);
  assert.ok(error instanceof AuthError);
  assert.deepEqual(failure(error), UNREACHABLE);
  assert.deepEqual(calls, [{ url: 'http://localhost:8088/v1/trees', method: 'POST', credentials: 'include' }]);
  assert.equal(buildRetirement.retired, 'write');
});

test('a retired build sends no write through any roadmap door', async () => {
  const calls = answer(204, {});
  const writes = [
    () => createTree({ title: 'Another' }),
    () => renameTree('t_sail', 'Renamed'),
    () => setVisibility('t_sail', 'private'),
    () => setGuide('t_sail', 'Go slowly.'),
    () => deleteTree('t_sail'),
  ];
  for (const write of writes) assert.deepEqual(failure(await write().catch((thrown) => thrown)), UNREACHABLE);
  assert.deepEqual(calls, []);
});
