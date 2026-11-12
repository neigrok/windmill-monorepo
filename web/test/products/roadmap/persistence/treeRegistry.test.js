import test from 'node:test';
import assert from 'node:assert/strict';

import { readGuides, setGuide, setVisibility } from '../../../../src/products/roadmap/persistence/TreeRegistry.js';
import { AuthError } from '../../../../src/shell/auth/AuthClient.js';

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

test('readGuides — GETs the tree’s guides credentialed under the caller’s signal and answers the reply', async () => {
  const reply = { guides: [{ treeId: 't_year', title: 'My year', text: 'Three things this year.', yours: true }] };
  const calls = stubFetch(() => ({ ok: true, status: 200, json: async () => reply }));
  const { signal } = new AbortController();

  assert.deepEqual(await readGuides('t_abc', signal), reply);
  assert.deepEqual(calls, [{ url: `${BASE}/v1/trees/t_abc/guides`, init: { credentials: 'include', signal } }]);
});

test('readGuides — a refusal keeps its status and code and nothing the server said, and a lost request is unreachable', async () => {
  for (const [status, body] of [[503, { code: 'guides-unavailable', error: 'the trees above My life could not be read' }], [404, { error: 'no such tree' }], [500, {}]]) {
    stubFetch(() => ({ ok: false, status, json: async () => body }));
    await assert.rejects(readGuides('t_abc'), (err) => {
      assert.ok(err instanceof AuthError);
      assert.deepEqual({ status: err.status, code: err.code, said: err.said, message: err.message },
        { status, code: body.code, said: undefined, message: 'Could not read the guides' });
      return true;
    });
  }
  stubFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(readGuides('t_abc'), (err) => {
    assert.deepEqual({ status: err.status, code: err.code, message: err.message }, { status: 0, code: 'unreachable', message: 'Network request failed' });
    return true;
  });
});

test('readGuides — a read its caller aborted rejects as the browser’s abort, not as a lost request', async () => {
  const request = new AbortController();
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  stubFetch(() => { request.abort(); throw aborted; });

  await assert.rejects(readGuides('t_abc', request.signal), (err) => err === aborted);
});
