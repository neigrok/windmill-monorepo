import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { gymApi } from '../../../src/products/gym/gymApi.js';

const realFetch = global.fetch;
let calls = [];

function serve(...answers) {
  calls = [];
  let turn = 0;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
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
      kind: 'working',
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

test('ask — one question into one thread, and the answer with its receipt, steps and proposals back', async () => {
  serve(whole({
    answer: 'Three sessions at the same top set, and the fourth lost a rep.',
    steps: [{ tool: 'get_stats', failed: false }, { tool: 'propose_routine_change', failed: false }],
    read: { sets: 214, sessions: 34, weeks: 12 },
    proposals: ['prop_0a1b2c3d'],
    thread: 'thr_0a1b2c3d4e5f6071',
  }));
  const reply = await gymApi.askStream('thr_0a1b2c3d4e5f6071', 'bench has been stuck at 82.5 for three weeks. What do you see?', 'ask_1');
  assert.deepEqual(reply, {
    pending: false,
    answer: 'Three sessions at the same top set, and the fourth lost a rep.',
    steps: [{ tool: 'get_stats', failed: false }, { tool: 'propose_routine_change', failed: false }],
    read: { sets: 214, sessions: 34, weeks: 12 },
    proposals: ['prop_0a1b2c3d'],
    thread: 'thr_0a1b2c3d4e5f6071',
  });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/ask',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"thread":"thr_0a1b2c3d4e5f6071","question":"bench has been stuck at 82.5 for three weeks. What do you see?","requestId":"ask_1","stream":true}',
  });
});

test('ask — every refusal arrives with the machine word the room reads it by', async () => {
  const refusals = [
    [409, 'finish your workout first — Coach reads a log that has stopped moving', 'ask-session-open'],
    [409, 'this conversation holds four questions — start a new one', 'ask-thread-full'],
    [409, 'that conversation id is already in use — start a new one', 'ask-thread-taken'],
    [429, 'the next question frees up in a couple of hours', 'ask-daily-limit'],
    [429, 'this account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on', 'ask-out-of-budget'],
    [503, 'Coach isn’t part of this Windmill. Your log is still yours to read.', 'ask-not-configured'],
  ];
  for (const [status, sentence, code] of refusals) {
    serve(refusal(status, sentence, code));
    const error = await gymApi.askStream('thr_1', 'q', 'ask_1').catch((held) => held);
    assert.equal(error.status, status, code);
    assert.equal(error.code, code);
    assert.equal(error.detail, sentence);
  }
  serve({ ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  const absent = await gymApi.askStream('thr_1', 'q', 'ask_1').catch((held) => held);
  assert.equal(absent.status, 404);
  assert.equal(absent.code, '');
  assert.equal(absent.detail, '');
});

test('threads — every conversation, newest first, and one key in the reply', async () => {
  const august = new Date(2026, 7, 11, 21, 14).getTime();
  serve(ok({
    threads: [
      {
        id: 'thr_0a1b2c3d4e5f6071',
        title: '“Bench has been stuck at 82.5 for three weeks. What do you see?”',
        createdAt: august - 600000,
        askedAt: august,
        outcome: { kind: 'applied', changes: 4, routineId: 'rt_9f2c', routine: 'Push A' },
        proposals: [{
          id: 'prop_1', state: 'applied', changeCount: 4, routineId: 'rt_9f2c', routine: 'Push A',
          createdAt: august,
        }],
      },
    ],
  }));
  const threads = await gymApi.threads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, '“Bench has been stuck at 82.5 for three weeks. What do you see?”');
  assert.deepEqual(threads[0].outcome, { kind: 'applied', changes: 4, routineId: 'rt_9f2c', routine: 'Push A' });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/threads',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('thread — the turns arrive on the detail alone, and 404 is one answer for two facts', async () => {
  serve(ok({
    id: 'thr_1',
    title: 'Deload week — what should I cut?',
    createdAt: 1, askedAt: 2,
    outcome: { kind: 'read-only', changes: 0 },
    proposals: [],
    turns: [
      { from: 'lifter', text: 'Deload week — what should I cut?', at: 1 },
      { from: 'ask', text: 'Drop the top set and keep the back-offs.', at: 2 },
    ],
  }));
  const thread = await gymApi.thread('thr_1');
  assert.equal(thread.turns.length, 2);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/threads/thr_1',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  serve(refusal(404, 'no such conversation'));
  assert.equal(await gymApi.thread('thr_gone'), null);
  serve(refusal(404, 'no such conversation'));
  assert.equal(await gymApi.thread('thr_somebody_elses'), null);
});

test('deleteThread — 204 and nothing back, for a conversation deleted twice as readily as once', async () => {
  serve(nothing());
  assert.equal(await gymApi.deleteThread('thr_1'), null);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/threads/thr_1',
    method: 'DELETE',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
  serve(nothing());
  assert.equal(await gymApi.deleteThread('thr_1'), null);
});

test('Coach generation status and failed action results survive the transport boundary', async () => {
  const generation = { id: 'gen_1', requestId: 'ask_retry', status: 'running', question: 'Create Push.', answer: '', at: 10 };
  serve(whole({ thread: 'thr_1', generation, results: [] }, 202));
  assert.deepEqual(await gymApi.askStream('thr_1', 'Create Push.', 'ask_retry'), { thread: 'thr_1', generation, results: [], pending: true });
  assert.deepEqual(JSON.parse(calls[0].options.body), { thread: 'thr_1', question: 'Create Push.', requestId: 'ask_retry', stream: true });
  const results = [{ kind: 'routine-created', operationId: 'op_1', routineId: 'rt_1', routineName: 'Push' }];
  serve({ ok: false, status: 502, json: async () => ({ error: 'Response interrupted.', generation: { ...generation, status: 'failed', results }, results }) });
  await assert.rejects(gymApi.askStream('thr_1', 'Create Push.', 'ask_retry'), (error) => {
    assert.equal(error.detail, 'Response interrupted.');
    assert.deepEqual(error.generation, { ...generation, status: 'failed', results });
    return true;
  });
});
