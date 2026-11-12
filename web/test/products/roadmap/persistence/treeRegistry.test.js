import test from 'node:test';
import assert from 'node:assert/strict';

import { setGuide, setVisibility } from '../../../../src/products/roadmap/persistence/TreeRegistry.js';
import { AuthError } from '../../../../src/shell/auth/AuthClient.js';
import { listServerTrees, readTreeCard } from '../../../../src/products/roadmap/persistence/TreeRegistry.js';

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

test('listServerTrees — the account’s server rows newest first, and a list that could not be read says how', async () => {
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ trees: [
    { id: 't_old', title: 'Old', done: 1, total: 4, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 't_new', title: 'New', done: 0, total: 5, updatedAt: '2026-03-01T00:00:00Z' },
    { id: 't_mid', title: 'Mid', done: 3, total: 8, updatedAt: 1769904000000 },
  ] }) }));
  assert.deepEqual(await listServerTrees(), { authoritative: true, rows: [
    { id: 't_new', title: 'New', done: 0, total: 5, updatedAt: '2026-03-01T00:00:00Z' },
    { id: 't_mid', title: 'Mid', done: 3, total: 8, updatedAt: 1769904000000 },
    { id: 't_old', title: 'Old', done: 1, total: 4, updatedAt: '2026-01-01T00:00:00Z' },
  ] });
  assert.deepEqual(calls.map(({ url, init }) => ({ url, credentials: init.credentials })), [{ url: `${BASE}/v1/trees`, credentials: 'include' }]);

  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ trees: [] }) }));
  assert.deepEqual(await listServerTrees(), { authoritative: true, rows: [] });
  stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.deepEqual(await listServerTrees(), { authoritative: false, status: 503, rows: [] });
  stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.deepEqual(await listServerTrees(), { authoritative: false, status: 401, rows: [] });
  global.fetch = async () => { throw new TypeError('failed to fetch'); };
  assert.deepEqual(await listServerTrees(), { authoritative: false, status: 0, rows: [] });
});

test('readTreeCard — a roadmap someone else shares, one of the person’s own, and none they can read', async () => {
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ mine: false, data: { title: 'Reefing course', nodes: [{ id: 'a' }, { id: 'b' }] } }) }));
  assert.deepEqual(await readTreeCard('t_reef'), { id: 't_reef', title: 'Reefing course', author: null, steps: 2, mine: false });
  assert.deepEqual(calls.map(({ url, init }) => ({ url, credentials: init.credentials })), [{ url: `${BASE}/v1/trees/t_reef`, credentials: 'include' }]);

  stubFetch(() => ({ ok: true, status: 200, json: async () => ({ mine: true, data: { title: 'My year', author: 'Sam', nodes: [] } }) }));
  assert.deepEqual(await readTreeCard('t_year'), { id: 't_year', title: 'My year', author: 'Sam', steps: 0, mine: true });

  const odd = stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
  assert.equal(await readTreeCard('a/b?c'), null);
  assert.equal(odd[0].url, `${BASE}/v1/trees/a%2Fb%3Fc`);
});

test('readTreeCard — a server failure and a dead network throw their status, which says nothing of the roadmap', async () => {
  stubFetch(() => ({ ok: false, status: 503, json: async () => ({ error: 'the trees this tree opens could not be read' }) }));
  await assert.rejects(readTreeCard('t_reef'), (err) => {
    assert.deepEqual({ kind: err instanceof AuthError, status: err.status, message: err.message }, { kind: true, status: 503, message: 'Could not read the roadmap' });
    return true;
  });
  global.fetch = async () => { throw new TypeError('failed to fetch'); };
  await assert.rejects(readTreeCard('t_reef'), (err) => {
    assert.deepEqual({ kind: err instanceof AuthError, status: err.status, code: err.code }, { kind: true, status: 0, code: 'unreachable' });
    return true;
  });
});

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
    assert.equal(err.said, 'unknown visibility');
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

test('setVisibility — a 402 carries the code AND the detail through to the dialog', async () => {
  stubFetch(() => ({
    ok: false,
    status: 402,
    json: async () => ({
      error: 'Private trees are part of Windmill One',
      detail: 'Unlisted keeps this tree reachable only by its link, and stays free.',
      code: 'pro_required',
    }),
  }));
  await assert.rejects(setVisibility('t_abc', 'private'), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.code, 'pro_required');
    assert.equal(err.status, 402);
    assert.equal(err.said, 'Private trees are part of Windmill One');
    assert.equal(err.detail, 'Unlisted keeps this tree reachable only by its link, and stays free.');
    return true;
  });
});

test('setGuide — PATCHes {guide} credentialed, resolves on 204, and keeps a refusal\'s status and sentence', async () => {
  const calls = stubFetch(() => ({ ok: true, status: 204 }));
  assert.equal(await setGuide('t_abc', 'One step a week.'), undefined);
  assert.deepEqual({ url: calls[0].url, method: calls[0].init.method, credentials: calls[0].init.credentials, body: JSON.parse(calls[0].init.body) },
    { url: `${BASE}/v1/trees/t_abc`, method: 'PATCH', credentials: 'include', body: { guide: 'One step a week.' } });
  for (const [status, body] of [[400, { error: 'the guide is 5001 characters; the most is 5000' }], [403, { code: 'not-yours' }], [404, {}]]) {
    stubFetch(() => ({ ok: false, status, json: async () => body }));
    await assert.rejects(setGuide('t_abc', 'x'), (err) => {
      assert.ok(err instanceof AuthError);
      assert.deepEqual({ status: err.status, code: err.code, said: err.said, message: err.message },
        { status, code: body.code, said: body.error, message: 'Could not save the guide' });
      return true;
    });
  }
});
