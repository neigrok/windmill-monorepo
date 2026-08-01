// The gym wire contract from the client's side — what each status means to a flush queue that has
// to decide, without a human, whether a set is lost, retryable, or already durable, and which of
// the four machine codes tells it how to repair the one that isn't. The sentences here are
// deliberately not the ones the server ships: a refusal reworded overnight must classify the same.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { gymApi, GymError } from '../../../src/products/gym/gymApi.js';

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

function flagsOf(error) {
  return {
    name: error.name,
    status: error.status,
    message: error.message,
    detail: error.detail,
    code: error.code,
    terminal: error.terminal,
    retryable: error.retryable,
    sessionFinished: error.sessionFinished,
    setIdTaken: error.setIdTaken,
    sessionIdTaken: error.sessionIdTaken,
    unknownExercise: error.unknownExercise,
  };
}

test.afterEach(() => { global.fetch = realFetch; calls = []; });

test('every call is cookie-credentialed json against the gym root', async () => {
  serve(ok({ exercises: [{ id: 'back-squat', name: 'Back Squat' }] }));
  assert.deepEqual(await gymApi.exercises(), [{ id: 'back-squat', name: 'Back Squat' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_BASE}/v1/gym/exercises`);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/exercises',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('sessions — the pager sends the instant AND the id, and sends neither when unasked', async () => {
  serve(ok({ sessions: [] }));
  assert.deepEqual(await gymApi.sessions(), []);
  assert.deepEqual(wireOf(calls[0]).path, '/v1/gym/sessions');

  serve(ok({ sessions: [{ id: 'ses_1', startedAt: 1_900_000_000_000, setCount: 5, exercises: ['Back Squat'] }] }));
  assert.deepEqual(await gymApi.sessions({ before: 1_900_000_000_000, beforeId: 'ses_1', limit: 20 }), [
    { id: 'ses_1', startedAt: 1_900_000_000_000, setCount: 5, exercises: ['Back Squat'] },
  ]);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/sessions?before=1900000000000&beforeId=ses_1&limit=20');

  serve(ok({ sessions: [] }));
  await gymApi.sessions({ before: 1_900_000_000_000 });
  assert.equal(wireOf(calls[0]).path, '/v1/gym/sessions?before=1900000000000');
});

test('session — an absent session is null, not an error: absent and another owner read the same', async () => {
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.session('ses_someone_elses'), null);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/sessions/ses_someone_elses');

  const detail = { session: { id: 'ses_1', startedAt: 1_900_000_000_000 }, sets: [] };
  serve(ok(detail));
  assert.deepEqual(await gymApi.session('ses_1'), detail);
});

test('appendSet — a replay of a stored set answers 200 with the stored row, finished or not', async () => {
  const stored = {
    id: 'set_1', exerciseId: 'back-squat', setNumber: 3, weightKg: 82.5, reps: 8,
    kind: 'working', note: '', completedAt: 1_900_000_300_000,
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.appendSet('ses_1', { id: 'set_1', exerciseId: 'back-squat', weightKg: 82.5, reps: 8, completedAt: 1_900_000_300_000 }), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/sets',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"id":"set_1","exerciseId":"back-squat","weightKg":82.5,"reps":8,"completedAt":1900000300000}',
  });
});

// Each of the four arrives here under a sentence NOBODY wrote — the point of the code is that a
// reworded refusal still classifies, so the fixture rewords every one of them.
test('session-finished — the code, not the sentence, says this set will never land here', async () => {
  serve(refusal(409, 'this session was closed at 18:42', 'session-finished'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_new' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'this session was closed at 18:42',
      detail: 'this session was closed at 18:42',
      code: 'session-finished',
      terminal: true,
      retryable: false,
      sessionFinished: true,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});

test('set-id-taken — the code says mint a fresh set id, so a reword can never drop the set', async () => {
  serve(refusal(409, 'that identifier already names a set', 'set-id-taken'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that identifier already names a set',
      detail: 'that identifier already names a set',
      code: 'set-id-taken',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: true,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});

test('session-id-taken — the code says mint a fresh session id', async () => {
  serve(refusal(409, 'that identifier is already in use', 'session-id-taken'));
  await assert.rejects(() => gymApi.startSession({ id: 'ses_1', startedAt: 1_900_000_000_000 }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that identifier is already in use',
      detail: 'that identifier is already in use',
      code: 'session-id-taken',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: true,
      unknownExercise: false,
    });
    return true;
  });
});

test('unknown-exercise — a 400 with a repair of its own: reload the catalog, never retry this body', async () => {
  serve(refusal(400, 'that movement is not in the catalog', 'unknown-exercise'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1', exerciseId: 'zercher-squat' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 400,
      message: 'that movement is not in the catalog',
      detail: 'that movement is not in the catalog',
      code: 'unknown-exercise',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: true,
    });
    return true;
  });
});

// The courtesy path: a server deployed before the codes shipped answers with the sentence alone,
// and mid-deploy a client talks to both. The four still classify, and error.code still reads the
// same machine word — a caller never learns which server it reached.
test('a codeless refusal still classifies by the sentence it shipped with', async () => {
  const sentences = [
    [409, 'that session is finished', 'session-finished'],
    [409, 'that set id is already used', 'set-id-taken'],
    [409, 'that session id is taken', 'session-id-taken'],
    [400, 'no such exercise', 'unknown-exercise'],
  ];
  for (const [status, sentence, code] of sentences) {
    serve(refusal(status, sentence));
    await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
      assert.deepEqual(flagsOf(error), {
        name: 'GymError',
        status,
        message: sentence,
        detail: sentence,
        code,
        terminal: true,
        retryable: false,
        sessionFinished: code === 'session-finished',
        setIdTaken: code === 'set-id-taken',
        sessionIdTaken: code === 'session-id-taken',
        unknownExercise: code === 'unknown-exercise',
      });
      return true;
    });
  }
});

// A conflict this client has never heard of is still a conflict: terminal, and repaired by none of
// the three. Guessing one of them would re-mint an id that was never the problem.
test('a 409 with an unknown code, or none at all, is terminal but unrepairable', async () => {
  serve(refusal(409, 'that routine is already running', 'routine-running'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that routine is already running',
      detail: 'that routine is already running',
      code: 'routine-running',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });

  serve(refusal(409, 'that routine is already running'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that routine is already running',
      detail: 'that routine is already running',
      code: '',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});

test('400 is terminal and 5xx is retryable — a busy store never reads as a bad set', async () => {
  serve(refusal(400, 'could not read that set'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 400,
      message: 'could not read that set',
      detail: 'could not read that set',
      code: '',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });

  serve(refusal(503, 'could not store that set'));
  await assert.rejects(() => gymApi.appendSet('ses_1', { id: 'set_1' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 503,
      message: 'could not store that set',
      detail: 'could not store that set',
      code: '',
      terminal: false,
      retryable: true,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});

test('a refusal with no readable body still carries its status', async () => {
  serve({ ok: false, status: 500, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  await assert.rejects(() => gymApi.exercises(), (error) => {
    assert.equal(error instanceof GymError, true);
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 500,
      message: 'gym request failed: 500',
      detail: '',
      code: '',
      terminal: false,
      retryable: true,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});

test('401 and 404 are neither terminal nor retryable — they wait for a sign-in or a session', async () => {
  serve(refusal(401, 'sign in to open your training log'));
  await assert.rejects(() => gymApi.sessions(), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 401,
      message: 'sign in to open your training log',
      detail: 'sign in to open your training log',
      code: '',
      terminal: false,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });

  serve(refusal(404, 'no such session'));
  await assert.rejects(() => gymApi.finishSession('ses_gone', { finishedAt: 1_900_000_000_000 }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 404,
      message: 'no such session',
      detail: 'no such session',
      code: '',
      terminal: false,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
    });
    return true;
  });
});
