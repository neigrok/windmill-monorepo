import test from 'node:test';
import assert from 'node:assert/strict';

import { setVisibility } from '../../../src/skilltree/persistence/TreeRegistry.js';
import { AuthError } from '../../../src/skilltree/auth/AuthClient.js';

const BASE = 'http://localhost:8088';
const realFetch = global.fetch;

function stubFetch(impl) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return calls;
}

test.afterEach(() => { global.fetch = realFetch; });

test('setVisibility — PATCHes {visibility} credentialed and resolves on 204', async () => {
  const calls = stubFetch(() => ({ ok: true, status: 204 }));
  const result = await setVisibility('t_abc', 'unlisted');
  assert.equal(result, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/v1/trees/t_abc`);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { visibility: 'unlisted' });
});

test('setVisibility — a 401 becomes an unauthenticated AuthError', async () => {
  stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  await assert.rejects(setVisibility('t_abc', 'private'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.code, 'unauthenticated');
    assert.equal(err.status, 401);
    assert.equal(err.message, 'Sign in to change visibility');
    return true;
  });
});

test('setVisibility — a dead network becomes an unreachable AuthError', async () => {
  global.fetch = async () => { throw new TypeError('failed to fetch'); };
  await assert.rejects(setVisibility('t_abc', 'public'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.code, 'unreachable');
    assert.equal(err.status, 0);
    assert.equal(err.message, 'Network request failed');
    return true;
  });
});

test('setVisibility — a rejecting body surfaces its own error and code', async () => {
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'unknown visibility', code: 'bad-value' }) }));
  await assert.rejects(setVisibility('t_abc', 'sideways'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'bad-value');
    assert.equal(err.message, 'unknown visibility');
    return true;
  });
});

test('setVisibility — a 403 falls to the default message when the body is empty', async () => {
  stubFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
  await assert.rejects(setVisibility('t_abc', 'unlisted'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 403);
    assert.equal(err.code, undefined);
    assert.equal(err.message, 'Could not change visibility');
    return true;
  });
});
