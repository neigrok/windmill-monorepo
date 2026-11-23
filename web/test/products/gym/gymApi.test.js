import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { gymApi } from '../../../src/products/gym/gymApi.js';
import { registry } from '../../../src/platform/sync/schema.js';

const realFetch = global.fetch;
let calls = [];

function serve(...answers) {
  calls = [];
  let turn = 0;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers['Sync-Schema'], String(registry.version));
    const answer = answers[Math.min(turn, answers.length - 1)];
    turn += 1;
    return answer;
  };
}

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

// An answer the ask door sends whole rather than as a stream of snapshots.
function whole(body, status = 200) {
  return { ok: true, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body };
}

function nothing() {
  return { ok: true, status: 204, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
}

function refusal(status, error, code) {
  const body = {};
  if (error !== undefined) body.error = error;
  if (code !== undefined) body.code = code;
  return { ok: false, status, json: async () => body };
}

function wireOf({ url, options }) {
  const parsed = new URL(url);
  return {
    path: `${parsed.pathname}${parsed.search}`,
    method: options.method ?? 'GET',
    credentials: options.credentials,
    contentType: options.headers['content-type'],
    body: options.body,
  };
}

test.afterEach(() => { global.fetch = realFetch; calls = []; });

test('shareSession — the share link, minted on a tap, with no document to send', async () => {
  serve(ok({ token: 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0', expiresAt: 1_911_600_000_000 }));
  assert.deepEqual(await gymApi.shareSession('ses_1'), {
    token: 'JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0',
    expiresAt: 1_911_600_000_000,
  });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/share',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('revokeShare — revoked is deleted, and 204 is read as a status and never as bytes', async () => {
  serve(nothing());
  assert.equal(await gymApi.revokeShare('ses_1'), null);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/share',
    method: 'DELETE',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('revokeShare — nothing to revoke is revoked, and a store that failed is still a failure', async () => {
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.revokeShare('ses_gone'), null);
  serve(refusal(503, 'internal error'));
  await assert.rejects(() => gymApi.revokeShare('ses_1'), (error) => error.status === 503);
});

test('sharedSession — one workout, no ids in it, and one null for all three ways a token can fail', async () => {
  const reply = {
    startedAt: 1_909_000_000_000,
    finishedAt: 1_909_003_600_000,
    routine: 'Push A',
    sets: [{
      exercise: 'Bench Press',
      setNumber: 1,
      weightKg: 80,
      reps: 8,
      note: '',
      completedAt: 1_909_001_000_000,
    }],
  };
  serve(ok(reply));
  assert.deepEqual(await gymApi.sharedSession('JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0'), reply);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/shared/JcQ8w-3n1SxT_0aZbYq5rPm7LkHfDgVeU2iOtN4sRw0');
  assert.equal(JSON.stringify(reply).includes('"id"'), false);

  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('revoked'), null);
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('expired'), null);
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('never-existed'), null);
});

test('public JSON carries the generated schema and preserves upgrade refusals', async () => {
  for (const read of [() => gymApi.sharedSession('fixture'), () => gymApi.sharedLog('fixture')]) {
    serve(refusal(426, 'Update Windmill to keep using Gym.', 'client-update-required'));
    await assert.rejects(read, (error) => error.status === 426 && error.code === 'client-update-required' &&
      error.message === 'Update Windmill to keep using Gym.');
    assert.equal(calls.at(-1).options.headers['Sync-Schema'], String(registry.version));
  }
});
