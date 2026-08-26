import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import {
  EXPORT_BODYWEIGHT_HREF, EXPORT_HREF, EXPORT_NOTES_HREF, EXPORT_THREADS_HREF, failureReason, gymApi, GymError,
  UNCHANGED,
} from '../../../src/products/gym/gymApi.js';

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
    routineIdTaken: error.routineIdTaken,
    exerciseIdTaken: error.exerciseIdTaken,
    sessionOpen: error.sessionOpen,
    sessionAlreadyOpen: error.sessionAlreadyOpen,
    fixUnreadable: error.fixUnreadable,
    setNotFound: error.setNotFound,
    proposalSuperseded: error.proposalSuperseded,
    proposalSettled: error.proposalSettled,
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

test('lastSets — every movement’s last set, sparse, and it asks for nothing', async () => {
  const movements = [
    { exerciseId: 'back-squat', weightKg: 100, reps: 5, at: 1_785_600_000_000 },
    { exerciseId: 'bench-press', weightKg: 80, reps: 8, at: 1_785_600_000_000 },
  ];
  serve(ok({ movements }));
  assert.deepEqual(await gymApi.lastSets(), movements);
  assert.equal(calls.length, 1);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/exercises/last',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('lastSets — an account with no history answers an empty list, never an absent one', async () => {
  serve(ok({ movements: [] }));
  assert.deepEqual(await gymApi.lastSets(), []);
});

test('sessions — the pager sends the instant AND the id, and sends neither when unasked', async () => {
  serve(ok({ sessions: [] }));
  assert.deepEqual(await gymApi.sessions(), []);
  assert.deepEqual(wireOf(calls[0]).path, '/v1/gym/sessions');

  serve(ok({ sessions: [{ id: 'ses_1', startedAt: 1_900_000_000_000, setCount: 5, exercises: ['Back Squat'], record: false }] }));
  assert.deepEqual(await gymApi.sessions({ before: 1_900_000_000_000, beforeId: 'ses_1', limit: 20 }), [
    { id: 'ses_1', startedAt: 1_900_000_000_000, setCount: 5, exercises: ['Back Squat'], record: false },
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

test('session — the ETag rides the reply, If-None-Match rides the next ask, and 304 is UNCHANGED', async () => {
  const detail = { session: { id: 'ses_1', startedAt: 1_900_000_000_000 }, sets: [] };
  const tagged = {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? 'W/"0-0-0"' : null) },
    json: async () => detail,
  };
  serve(tagged);
  assert.deepEqual(await gymApi.session('ses_1'), { ...detail, etag: 'W/"0-0-0"' });
  assert.equal(calls[0].options.headers['if-none-match'], undefined);

  const notModified = {
    ok: false,
    status: 304,
    headers: { get: () => null },
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
  };
  serve(notModified);
  assert.equal(await gymApi.session('ses_1', { etag: 'W/"0-0-0"' }), UNCHANGED);
  assert.equal(calls[0].options.headers['if-none-match'], 'W/"0-0-0"');
});

test('lastTime — one read, and the answer arrives whole', async () => {
  const reply = {
    exerciseId: 'back-squat',
    session: { id: 'ses_probe_old', startedAt: 1_900_001_000_000, finishedAt: 1_900_001_360_000 },
    routine: 'Squat day',
    sets: [
      { id: 'set_probe_s1', exerciseId: 'back-squat', setNumber: 2, weightKg: 100, reps: 8, kind: 'working', note: '', completedAt: 1_900_001_120_000 },
      { id: 'set_probe_s2', exerciseId: 'back-squat', setNumber: 3, weightKg: 100, reps: 7, kind: 'working', note: '', completedAt: 1_900_001_180_000 },
      { id: 'set_probe_s3', exerciseId: 'back-squat', setNumber: 4, weightKg: 97.5, reps: 5, kind: 'working', note: 'grindy', rpe: 9, completedAt: 1_900_001_240_000 },
    ],
  };
  serve(ok(reply));
  assert.deepEqual(await gymApi.lastTime('back-squat'), reply);
  assert.equal(calls.length, 1);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/last?exercise=back-squat',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  serve(ok({ exerciseId: 'ez-bar curl' }));
  await gymApi.lastTime('ez-bar curl');
  assert.equal(wireOf(calls[0]).path, '/v1/gym/last?exercise=ez-bar%20curl');
});

test('lastTime — a first-ever movement answers 200 with the movement and nothing else', async () => {
  serve(ok({ exerciseId: 'deadlift' }));
  assert.deepEqual(await gymApi.lastTime('deadlift'), { exerciseId: 'deadlift' });
});

test('lastTime — a movement no catalog holds is the one refusal, and it is the write path’s word', async () => {
  serve(refusal(400, 'no such exercise', 'unknown-exercise'));
  await assert.rejects(() => gymApi.lastTime('zercher-squat'), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 400,
      message: 'no such exercise',
      detail: 'no such exercise',
      code: 'unknown-exercise',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: true,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
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

test('fixSet — the fix carries only what moved, and the stored set comes back', async () => {
  const stored = {
    id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 50, reps: 5,
    kind: 'working', rpe: 8.5, note: 'felt heavy', completedAt: 1_900_000_300_000,
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.fixSet('ses_1', 'set_3', { weightKg: 50, reps: 5 }), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/sets/set_3',
    method: 'PATCH',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"weightKg":50,"reps":5}',
  });
});

test('fix-unreadable — a fix the store would not take is terminal, and retrying those bytes never lands', async () => {
  serve(refusal(400, 'could not read that fix', 'fix-unreadable'));
  await assert.rejects(() => gymApi.fixSet('ses_1', 'set_3', { exerciseId: 'bench-press' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 400,
      message: 'could not read that fix',
      detail: 'could not read that fix',
      code: 'fix-unreadable',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: true,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

test('set-not-found — one answer for all four ways a set can fail to be in that workout', async () => {
  serve(refusal(404, 'no such set', 'set-not-found'));
  await assert.rejects(() => gymApi.fixSet('ses_1', 'set_gone', { reps: 5 }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 404,
      message: 'no such set',
      detail: 'no such set',
      code: 'set-not-found',
      terminal: false,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: true,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

test('fixSet — a set in a session that is over corrects like any other', async () => {
  const stored = {
    id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 47.5, reps: 5,
    kind: 'working', note: '', completedAt: 1_900_000_300_000,
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.fixSet('ses_closed', 'set_3', { reps: 5 }), stored);
  assert.equal(calls.length, 1);
});

test('deleteSet — the set does not stand, and a delete of a set that never did answers the same', async () => {
  serve(nothing());
  assert.equal(await gymApi.deleteSet('ses_1', 'set_3'), null);
  assert.equal(await gymApi.deleteSet('ses_1', 'set_3'), null);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/sets/set_3',
    method: 'DELETE',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
  assert.deepEqual(wireOf(calls[1]), wireOf(calls[0]));
});

test('deleteSet — a store that failed is retryable, and it is the only non-204 with a body', async () => {
  serve(refusal(500, 'the log is not answering'));
  await assert.rejects(() => gymApi.deleteSet('ses_1', 'set_3'), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.terminal, false);
    assert.equal(error.retryable, true);
    assert.equal(error.setNotFound, false);
    return true;
  });
});

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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

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
        routineIdTaken: code === 'routine-id-taken',
        exerciseIdTaken: code === 'exercise-id-taken',
        sessionOpen: code === 'session-open',
        sessionAlreadyOpen: code === 'session-already-open',
        fixUnreadable: false,
        setNotFound: false,
        proposalSuperseded: false,
        proposalSettled: false,
      });
      return true;
    });
  }
});

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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
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
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

test('startSession — routineId travels, and an unasked option is absent rather than false', async () => {
  const open = {
    id: 'ses_1',
    startedAt: 1_900_000_000_000,
    routineId: 'rt_push_a',
    plan: { routine: 'Push A', entries: [{ exerciseId: 'bench-press', sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180 }] },
  };
  serve(ok(open));
  assert.deepEqual(await gymApi.startSession({ id: 'ses_1', startedAt: 1_900_000_000_000, routineId: 'rt_push_a' }), open);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"id":"ses_1","startedAt":1900000000000,"routineId":"rt_push_a"}',
  });

  serve(ok(open));
  await gymApi.startSession({ id: 'ses_1', startedAt: 1_900_000_000_000 });
  assert.equal(wireOf(calls[0]).body, '{"id":"ses_1","startedAt":1900000000000}');

  serve(ok(open));
  await gymApi.startSession({ id: 'ses_2', startedAt: 1_900_000_000_000, joinOpenSession: false, routineId: 'rt_push_a' });
  assert.equal(wireOf(calls[0]).body, '{"id":"ses_2","startedAt":1900000000000,"joinOpenSession":false,"routineId":"rt_push_a"}');
});

test('createExercise — a movement the lifter minted, with the equipment default left out', async () => {
  const stored = { id: 'ex_31ab', name: 'Zercher Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: true };
  serve(ok(stored));
  assert.deepEqual(await gymApi.createExercise({ id: 'ex_31ab', name: 'Zercher Squat', pattern: 'squat', equipment: 'barbell' }), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/exercises',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"id":"ex_31ab","name":"Zercher Squat","pattern":"squat","equipment":"barbell"}',
  });
});

test('review — the finish screen arrives whole, and omissions are omissions', async () => {
  const review = {
    stats: { durationMs: 3_720_000, workingSets: 16, topE1rm: 122.5 },
    slight: false,
    record: {
      kind: 'e1rm',
      exerciseId: 'back-squat',
      value: 122.5,
      weightKg: 105,
      reps: 5,
      previous: 116.7,
      previousAt: 1_750_723_200_000,
    },
    against: {
      sessionId: 'ses_older',
      routine: 'Legs',
      startedAt: 1_750_723_200_000,
      movements: [{
        exerciseId: 'back-squat',
        now: { weightKg: 105, reps: 5, sets: 5 },
        before: { weightKg: 102.5, reps: 5, sets: 5 },
      }],
    },
  };
  serve(ok(review));
  assert.deepEqual(await gymApi.review('ses_1'), review);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_1/review',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  const slight = { stats: { durationMs: 660_000, workingSets: 3 }, slight: true };
  serve(ok(slight));
  assert.deepEqual(await gymApi.review('ses_short'), slight);
});

test('discardSession — the one destructive call, and 204 is read as a status and never as bytes', async () => {
  serve(nothing());
  assert.equal(await gymApi.discardSession('ses_short'), null);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/sessions/ses_short',
    method: 'DELETE',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('record — a movement’s page in one read, with the wire’s omissions kept as omissions', async () => {
  const reply = {
    exercise: { id: 'back-squat', name: 'Back Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false },
    routineCount: 2,
    sessionCount: 34,
    bestE1rm: { weightKg: 105, reps: 5, at: 1_909_000_000_000, e1rm: 122.5 },
    heaviest: { weightKg: 105, reps: 5, at: 1_909_000_000_000, e1rm: 122.5 },
    e1rmSeries: [{ at: 1_908_000_000_000, weightKg: 102.5, reps: 5, e1rm: 119.6 }],
    records: [{ at: 1_909_000_000_000, weightKg: 105, reps: 5, e1rm: 122.5 }],
    recentDays: [{
      sessionId: 'ses_1',
      startedAt: 1_909_000_000_000,
      sets: [{
        id: 'set_1', exerciseId: 'back-squat', setNumber: 1, weightKg: 105, reps: 5,
        kind: 'working', note: '', completedAt: 1_909_000_600_000,
      }],
    }],
  };
  serve(ok(reply));
  assert.deepEqual(await gymApi.record('back-squat'), reply);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/exercises/back-squat/record',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  const bodyweight = {
    exercise: { id: 'chin-up', name: 'Chin-up', pattern: 'pull', equipment: 'bodyweight', stepKg: 1, custom: false },
    routineCount: 1,
    sessionCount: 9,
    heaviest: { weightKg: 0, reps: 12, at: 1_909_100_000_000 },
    recentDays: [{
      sessionId: 'ses_2',
      startedAt: 1_909_100_000_000,
      sets: [{
        id: 'set_2', exerciseId: 'chin-up', setNumber: 1, weightKg: 0, reps: 12,
        kind: 'working', note: '', completedAt: 1_909_100_600_000,
      }],
    }],
  };
  serve(ok(bodyweight));
  assert.deepEqual(await gymApi.record('chin-up'), bodyweight);

  serve(ok({ exercise: { id: 'dip', name: 'Dip', pattern: 'press', equipment: 'bodyweight', stepKg: 1, custom: false }, routineCount: 0, sessionCount: 0 }));
  assert.deepEqual(await gymApi.record('dip'), {
    exercise: { id: 'dip', name: 'Dip', pattern: 'press', equipment: 'bodyweight', stepKg: 1, custom: false },
    routineCount: 0,
    sessionCount: 0,
  });
});

test('record — a movement that is not this account’s is null, not an error', async () => {
  serve(refusal(404, 'no such movement'));
  assert.equal(await gymApi.record('ex_somebody_elses'), null);

  serve(refusal(404, 'no such movement'));
  await gymApi.record('back squat/2');
  assert.equal(wireOf(calls[0]).path, '/v1/gym/exercises/back%20squat%2F2/record');
});

test('renameExercise — one field, and the id it answers with is the id it was given', async () => {
  const stored = { id: 'back-squat', name: 'High-bar Squat', pattern: 'squat', equipment: 'barbell', stepKg: 2.5, custom: false };
  serve(ok(stored));
  assert.deepEqual(await gymApi.renameExercise('back-squat', 'High-bar Squat'), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/exercises/back-squat',
    method: 'PATCH',
    credentials: 'include',
    contentType: 'application/json',
    body: '{"name":"High-bar Squat"}',
  });

  serve(refusal(400, 'could not read that name'));
  const refused = await gymApi.renameExercise('back-squat', '').catch((error) => error);
  assert.equal(refused.status, 400);
  assert.equal(refused.terminal, true);
  assert.equal(refused.retryable, false);
  assert.equal(failureReason(refused), 'the log wouldn’t take it as written');
});

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
  await assert.rejects(() => gymApi.revokeShare('ses_1'), (error) => error.status === 503 && error.retryable);
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

test('EXPORT_HREF — a link the browser follows, on the same origin as every other gym call', () => {
  assert.equal(EXPORT_HREF, `${API_BASE}/v1/gym/export`);
});

test('session-open — a discard against a live session is refused, and it is not repairable', async () => {
  serve(refusal(409, 'that session is still running', 'session-open'));
  await assert.rejects(() => gymApi.discardSession('ses_live'), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that session is still running',
      detail: 'that session is still running',
      code: 'session-open',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: true,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

test('routines — the list, the read, and an absent routine answered the way an absent session is', async () => {
  const routine = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    lastTrainedAt: 1_754_300_000_000,
    entries: [{ position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5, restSeconds: 180 }],
  };
  serve(ok({ routines: [routine] }));
  assert.deepEqual(await gymApi.routines(), [routine]);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/routines');

  serve(ok(routine));
  assert.deepEqual(await gymApi.routine('rt_push_a'), routine);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/routines/rt_push_a');

  serve(refusal(404, 'no such routine'));
  assert.equal(await gymApi.routine('rt_someone_elses'), null);
});

test('routines — create sends the document, replace sends it whole, delete answers 204', async () => {
  const write = {
    id: 'rt_pull_a',
    name: 'Pull A',
    position: 1,
    entries: [{ exerciseId: 'barbell-row', targetSets: 4, targetReps: 8, targetWeightKg: 70 }],
  };
  const stored = {
    ...write,
    entries: [{ position: 1, exerciseId: 'barbell-row', targetSets: 4, targetReps: 8, targetWeightKg: 70 }],
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.createRoutine(write), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/routines',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: JSON.stringify(write),
  });

  serve(ok(stored));
  assert.deepEqual(await gymApi.replaceRoutine('rt_pull_a', write), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/routines/rt_pull_a',
    method: 'PUT',
    credentials: 'include',
    contentType: 'application/json',
    body: JSON.stringify(write),
  });

  serve(nothing());
  assert.equal(await gymApi.deleteRoutine('rt_pull_a'), null);
  assert.equal(wireOf(calls[0]).method, 'DELETE');
  assert.equal(wireOf(calls[0]).path, '/v1/gym/routines/rt_pull_a');
});

test('routines — a pending proposal and the revision it is frozen against ride the routine', async () => {
  const routine = {
    id: 'rt_push_a',
    name: 'Push A',
    position: 0,
    revision: 2,
    lastTrainedAt: 1_754_300_000_000,
    pendingProposal: {
      id: 'prop_2f9c40a1',
      routineId: 'rt_push_a',
      intent: 'revise',
      state: 'pending',
      summary: 'Four weeks of heavier bench triples.',
      changeCount: 4,
      createdAt: 1_754_000_000_000,
      source: { door: 'mcp' },
    },
    entries: [{ position: 1, exerciseId: 'bench-press', targetSets: 5, targetReps: 5, targetWeightKg: 82.5 }],
  };
  serve(ok({ routines: [routine] }));
  assert.deepEqual(await gymApi.routines(), [routine]);

  const quiet = { id: 'rt_pull_a', name: 'Pull A', position: 1, revision: 1, entries: [] };
  serve(ok({ routines: [quiet] }));
  assert.deepEqual(await gymApi.routines(), [quiet]);
  assert.equal('pendingProposal' in quiet, false);
});

test('proposals — the ledger, filtered by routine and by the one state word the server knows', async () => {
  const head = {
    id: 'prop_2f9c40a1',
    routineId: 'rt_push_a',
    intent: 'revise',
    state: 'applied',
    summary: 'Heavier bench triples.',
    changeCount: 3,
    createdAt: 1_754_000_000_000,
    settledAt: 1_754_086_400_000,
    source: { door: 'mcp' },
  };
  serve(ok({ proposals: [head] }));
  assert.deepEqual(await gymApi.proposals({ routineId: 'rt_push_a' }), [head]);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/proposals?routineId=rt_push_a',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  serve(ok({ proposals: [] }));
  assert.deepEqual(await gymApi.proposals(), []);
  assert.equal(wireOf(calls[0]).path, '/v1/gym/proposals');

  serve(ok({ proposals: [] }));
  await gymApi.proposals({ routineId: 'rt_push_a', state: 'pending' });
  assert.equal(wireOf(calls[0]).path, '/v1/gym/proposals?routineId=rt_push_a&state=pending');
});

test('proposal — the diff arrives whole, and one that is not this account’s is null', async () => {
  const whole = {
    id: 'prop_2f9c40a1',
    routineId: 'rt_push_a',
    intent: 'revise',
    state: 'pending',
    summary: 'Heavier bench triples, incline work in place of flies.',
    changeCount: 2,
    createdAt: 1_754_000_000_000,
    source: { door: 'mcp' },
    baseRevision: 1,
    baseName: 'Push A',
    name: 'Push A',
    changes: [
      {
        position: 1,
        kind: 'retargeted',
        exerciseId: 'bench-press',
        before: { sets: 5, reps: 5, weightKg: 82.5, restSeconds: 180 },
        after: { sets: 5, reps: 3, weightKg: 87.5, restSeconds: 180 },
      },
      { position: 2, kind: 'removed', exerciseId: 'cable-fly', before: { sets: 3, reps: 12, weightKg: 22.5 }, loggedSets: 41 },
    ],
  };
  serve(ok(whole));
  assert.deepEqual(await gymApi.proposal('prop_2f9c40a1'), whole);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/proposals/prop_2f9c40a1',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  serve(refusal(404, 'no such proposal'));
  assert.equal(await gymApi.proposal('prop_someone_elses'), null);
});

test('applyProposal and dismissProposal — a POST with no body, and the store’s own answer back', async () => {
  const settled = { id: 'prop_2f9c40a1', routineId: 'rt_push_a', state: 'applied', changeCount: 2, settledAt: 1_754_086_400_000 };
  const routine = { id: 'rt_push_a', name: 'Push A', position: 0, revision: 2, entries: [] };
  serve(ok({ proposal: settled, routine }));
  assert.deepEqual(await gymApi.applyProposal('prop_2f9c40a1'), { proposal: settled, routine });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/proposals/prop_2f9c40a1/apply',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  const removal = { id: 'prop_9a17', routineId: 'rt_push_b', intent: 'remove', state: 'applied', settledAt: 1_754_086_400_000 };
  serve(ok({ proposal: removal }));
  assert.deepEqual(await gymApi.applyProposal('prop_9a17'), { proposal: removal });

  const dismissed = { ...settled, state: 'dismissed' };
  serve(ok({ proposal: dismissed }));
  assert.deepEqual(await gymApi.dismissProposal('prop_2f9c40a1'), { proposal: dismissed });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/proposals/prop_2f9c40a1/dismiss',
    method: 'POST',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });
});

test('proposal-superseded and proposal-settled — the world moved, and neither can be retried', async () => {
  serve(refusal(409, 'Push A changed after this proposal was written', 'proposal-superseded'));
  await assert.rejects(() => gymApi.applyProposal('prop_2f9c40a1'), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'Push A changed after this proposal was written',
      detail: 'Push A changed after this proposal was written',
      code: 'proposal-superseded',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: true,
      proposalSettled: false,
    });
    return true;
  });

  serve(refusal(409, 'that proposal was already dismissed', 'proposal-settled'));
  await assert.rejects(() => gymApi.dismissProposal('prop_2f9c40a1'), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that proposal was already dismissed',
      detail: 'that proposal was already dismissed',
      code: 'proposal-settled',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: true,
    });
    return true;
  });
});

test('a settled route answers 404 for a proposal that is not there, and it carries no code', async () => {
  serve(refusal(404, 'no such proposal'));
  await assert.rejects(() => gymApi.applyProposal('prop_gone'), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, '');
    assert.equal(error.terminal, false);
    assert.equal(error.retryable, false);
    assert.equal(error.proposalSuperseded, false);
    assert.equal(error.proposalSettled, false);
    return true;
  });
});

test('preferences — one read that always answers, and a whole-document write that answers with the store’s copy', async () => {
  const stored = {
    units: 'kg',
    restSeconds: 120,
    restSound: true,
    confirmHaptic: true,
    confirmSound: false,
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.preferences(), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/preferences',
    method: 'GET',
    credentials: 'include',
    contentType: 'application/json',
    body: undefined,
  });

  const write = { ...stored, units: 'lb' };
  serve(ok(stored));
  assert.deepEqual(await gymApi.savePreferences(write), stored);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/preferences',
    method: 'PUT',
    credentials: 'include',
    contentType: 'application/json',
    body: JSON.stringify(write),
  });
});

test('preferences — every refusal is terminal, keeps its code, and carries the band in words', async () => {
  const refusals = [
    ['preferences-unreadable', 'that isn’t a settings document'],
    ['unknown-unit', 'units are "kg" or "lb"'],
    ['rest-target', 'a rest target runs from 15 to 900 seconds — send none for no timer'],
  ];
  for (const [code, sentence] of refusals) {
    serve(refusal(400, sentence, code));
    const error = await gymApi.savePreferences({}).then(() => null, (thrown) => thrown);
    assert.equal(error.code, code);
    assert.equal(error.detail, sentence);
    assert.equal(error.terminal, true);
    assert.equal(error.retryable, false);
  }
});

test('routine-id-taken and exercise-id-taken — a spent id, and the same repair on each', async () => {
  serve(refusal(409, 'that routine id is taken', 'routine-id-taken'));
  await assert.rejects(() => gymApi.createRoutine({ id: 'rt_push_a', name: 'Push A', position: 0, entries: [] }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that routine id is taken',
      detail: 'that routine id is taken',
      code: 'routine-id-taken',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: true,
      exerciseIdTaken: false,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });

  serve(refusal(409, 'that movement id is taken', 'exercise-id-taken'));
  await assert.rejects(() => gymApi.createExercise({ id: 'ex_31ab', name: 'Zercher Squat' }), (error) => {
    assert.deepEqual(flagsOf(error), {
      name: 'GymError',
      status: 409,
      message: 'that movement id is taken',
      detail: 'that movement id is taken',
      code: 'exercise-id-taken',
      terminal: true,
      retryable: false,
      sessionFinished: false,
      setIdTaken: false,
      sessionIdTaken: false,
      unknownExercise: false,
      routineIdTaken: false,
      exerciseIdTaken: true,
      sessionOpen: false,
      sessionAlreadyOpen: false,
      fixUnreadable: false,
      setNotFound: false,
      proposalSuperseded: false,
      proposalSettled: false,
    });
    return true;
  });
});

test('unknown-exercise — a routine entry can reach the same refusal a set can', async () => {
  serve(refusal(400, 'no such exercise', 'unknown-exercise'));
  await assert.rejects(
    () => gymApi.replaceRoutine('rt_push_a', { id: 'rt_push_a', name: 'Push A', position: 0, entries: [{ exerciseId: 'zercher-squat', targetSets: 3 }] }),
    (error) => {
      assert.deepEqual(flagsOf(error), {
        name: 'GymError',
        status: 400,
        message: 'no such exercise',
        detail: 'no such exercise',
        code: 'unknown-exercise',
        terminal: true,
        retryable: false,
        sessionFinished: false,
        setIdTaken: false,
        sessionIdTaken: false,
        unknownExercise: true,
        routineIdTaken: false,
        exerciseIdTaken: false,
        sessionOpen: false,
        sessionAlreadyOpen: false,
        fixUnreadable: false,
        setNotFound: false,
        proposalSuperseded: false,
        proposalSettled: false,
      });
      return true;
    },
  );
});

test('the three routine-era refusals classify from the sentence alone as well', async () => {
  const sentences = [
    ['that routine id is taken', 'routine-id-taken'],
    ['that movement id is taken', 'exercise-id-taken'],
    ['that session is still running', 'session-open'],
  ];
  for (const [sentence, code] of sentences) {
    serve(refusal(409, sentence));
    await assert.rejects(() => gymApi.discardSession('ses_1'), (error) => {
      assert.deepEqual(flagsOf(error), {
        name: 'GymError',
        status: 409,
        message: sentence,
        detail: sentence,
        code,
        terminal: true,
        retryable: false,
        sessionFinished: false,
        setIdTaken: false,
        sessionIdTaken: false,
        unknownExercise: false,
        routineIdTaken: code === 'routine-id-taken',
        exerciseIdTaken: code === 'exercise-id-taken',
        sessionOpen: code === 'session-open',
        sessionAlreadyOpen: code === 'session-already-open',
        fixUnreadable: false,
        setNotFound: false,
        proposalSuperseded: false,
        proposalSettled: false,
      });
      return true;
    });
  }
});

test('session-already-open — a backfill that met a live workout is its own refusal, not a 409', async () => {
  for (const answer of [
    refusal(409, 'another session is already open', 'session-already-open'),
    refusal(409, 'another session is already open'),
  ]) {
    serve(answer);
    await assert.rejects(() => gymApi.startSession({ id: 'ses_1', startedAt: 1, joinOpenSession: false }), (error) => {
      assert.deepEqual(flagsOf(error), {
        name: 'GymError',
        status: 409,
        message: 'another session is already open',
        detail: 'another session is already open',
        code: 'session-already-open',
        terminal: true,
        retryable: false,
        sessionFinished: false,
        setIdTaken: false,
        sessionIdTaken: false,
        unknownExercise: false,
        routineIdTaken: false,
        exerciseIdTaken: false,
        sessionOpen: false,
        sessionAlreadyOpen: true,
        fixUnreadable: false,
        setNotFound: false,
        proposalSuperseded: false,
        proposalSettled: false,
      });
      return true;
    });
  }
  serve(refusal(409, 'that session id is taken', 'session-id-taken'));
  await assert.rejects(() => gymApi.startSession({ id: 'ses_1', startedAt: 1, joinOpenSession: false }), (error) => {
    assert.equal(error.sessionAlreadyOpen, false);
    assert.equal(error.sessionIdTaken, true);
    return true;
  });
});

test('failureReason — a refusal, a lapsed sign-in, a row that is gone and a silence each get their own sentence', async () => {
  assert.equal(failureReason(new GymError(400, 'a routine needs at least one movement')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(409, 'that routine id is taken', 'routine-id-taken')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(503, '')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(new GymError(401, 'sign in to open your training log')), 'you’re signed out. Sign in and try again');
  assert.equal(failureReason(new GymError(404, 'no such session')), 'it isn’t in the log any more');
  assert.equal(failureReason(new TypeError('Failed to fetch')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(undefined), 'the log didn’t answer. Try again when you have signal');
});

test('ask — one question into one thread, and the answer with its receipt, steps and proposals back', async () => {
  serve(ok({
    answer: 'Three sessions at the same top set, and the fourth lost a rep.',
    steps: [{ tool: 'get_stats', failed: false }, { tool: 'propose_routine_change', failed: false }],
    read: { sets: 214, sessions: 34, weeks: 12 },
    proposals: ['prop_0a1b2c3d'],
    thread: 'thr_0a1b2c3d4e5f6071',
  }));
  const reply = await gymApi.ask('thr_0a1b2c3d4e5f6071', 'bench has been stuck at 82.5 for three weeks. What do you see?');
  assert.deepEqual(reply, {
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
    body: '{"thread":"thr_0a1b2c3d4e5f6071","question":"bench has been stuck at 82.5 for three weeks. What do you see?"}',
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
    const error = await gymApi.ask('thr_1', 'q').catch((held) => held);
    assert.equal(error.status, status, code);
    assert.equal(error.code, code);
    assert.equal(error.detail, sentence);
  }
  serve({ ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  const absent = await gymApi.ask('thr_1', 'q').catch((held) => held);
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

test('EXPORT_THREADS_HREF — the conversations as their own file, on the same origin', () => {
  assert.equal(EXPORT_THREADS_HREF, `${API_BASE}/v1/gym/export/threads`);
  assert.notEqual(EXPORT_THREADS_HREF, EXPORT_HREF);
});

test('EXPORT_NOTES_HREF — the third CSV, the notes as their own file, on the same origin', () => {
  assert.equal(EXPORT_NOTES_HREF, `${API_BASE}/v1/gym/export/notes`);
  assert.equal(new Set([EXPORT_HREF, EXPORT_THREADS_HREF, EXPORT_NOTES_HREF]).size, 3);
});

test('notes — the list is the store’s order, and an account with none is an empty list', async () => {
  serve(ok({ notes: [{ id: 'note_a', position: 0, title: 'Tone', body: 'Blunt.', updatedAt: 1 }] }));
  assert.deepEqual(await gymApi.notes(), [{ id: 'note_a', position: 0, title: 'Tone', body: 'Blunt.', updatedAt: 1 }]);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/notes', method: 'GET', credentials: 'include', contentType: 'application/json', body: undefined,
  });
  serve(ok({ notes: [] }));
  assert.deepEqual(await gymApi.notes(), []);
});

test('saveNote — an upsert on the client-minted id, title and body only, the stored note back', async () => {
  serve(ok({ note: { id: 'note_a', position: 0, title: 'Tone', body: 'Blunt.', updatedAt: 1 } }));
  assert.deepEqual(await gymApi.saveNote('note_a', { title: 'Tone', body: 'Blunt.' }), {
    id: 'note_a', position: 0, title: 'Tone', body: 'Blunt.', updatedAt: 1,
  });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/notes/note_a', method: 'PUT', credentials: 'include', contentType: 'application/json',
    body: '{"title":"Tone","body":"Blunt."}',
  });
});

test('saveNote — the store’s refusals arrive with their sentence and their code', async () => {
  serve(refusal(409, '10 of 10 notes. Delete one to add another.', 'notes-full'));
  await assert.rejects(gymApi.saveNote('note_k', { title: 'Eleventh', body: '' }), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.detail, '10 of 10 notes. Delete one to add another.');
    assert.equal(error.code, 'notes-full');
    assert.equal(error.terminal, true);
    return true;
  });
  serve(refusal(400, 'a note runs to 500 bytes'));
  await assert.rejects(gymApi.saveNote('note_a', { title: 'Tone', body: 'x' }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.detail, 'a note runs to 500 bytes');
    return true;
  });
});

test('deleteNote — a 204 whether the note was there or already gone', async () => {
  serve(nothing());
  assert.equal(await gymApi.deleteNote('note_a'), null);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/notes/note_a', method: 'DELETE', credentials: 'include', contentType: 'application/json', body: undefined,
  });
});

test('reorderNotes — the whole order in one write, the renumbered list back', async () => {
  serve(ok({ notes: [{ id: 'note_b', position: 0, title: 'B', body: '', updatedAt: 1 }, { id: 'note_a', position: 1, title: 'A', body: '', updatedAt: 1 }] }));
  const notes = await gymApi.reorderNotes(['note_b', 'note_a']);
  assert.deepEqual(notes.map((note) => [note.id, note.position]), [['note_b', 0], ['note_a', 1]]);
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/notes', method: 'PUT', credentials: 'include', contentType: 'application/json',
    body: '{"order":["note_b","note_a"]}',
  });
  serve(refusal(400, 'that order does not name every note', 'notes-order-mismatch'));
  await assert.rejects(gymApi.reorderNotes(['note_b']), (error) => {
    assert.equal(error.code, 'notes-order-mismatch');
    return true;
  });
});

test('bodyweight — the series, whole or between two inclusive dates, as the wire sends it', async () => {
  const series = { entries: [{ dateLocal: '2026-08-25', weightKg: 82.4, recordedAt: 1 }], latest: { dateLocal: '2026-08-25', weightKg: 82.4, recordedAt: 1 } };
  serve(ok(series));
  assert.deepEqual(await gymApi.bodyweight(), series);
  assert.deepEqual(wireOf(calls[0]), { path: '/v1/gym/bodyweight', method: 'GET', credentials: 'include', contentType: 'application/json', body: undefined });
  serve(ok({ entries: [], latest: null }));
  assert.deepEqual(await gymApi.bodyweight({ from: '2026-06-01', to: '2026-08-26' }), { entries: [], latest: null });
  assert.equal(wireOf(calls[0]).path, '/v1/gym/bodyweight?from=2026-06-01&to=2026-08-26');
});

test('saveBodyweight — one PUT per local date carrying kilograms and the device clock, the stored row back', async () => {
  serve(ok({ entry: { dateLocal: '2026-08-26', weightKg: 82.4, recordedAt: 9 } }));
  assert.deepEqual(await gymApi.saveBodyweight('2026-08-26', { weightKg: 82.4, recordedAt: 9 }), { dateLocal: '2026-08-26', weightKg: 82.4, recordedAt: 9 });
  assert.deepEqual(wireOf(calls[0]), {
    path: '/v1/gym/bodyweight/2026-08-26', method: 'PUT', credentials: 'include', contentType: 'application/json',
    body: '{"weightKg":82.4,"recordedAt":9}',
  });
  serve(refusal(400, 'Between 20 and 400 kg — check the number.'));
  await assert.rejects(gymApi.saveBodyweight('2026-08-26', { weightKg: 420, recordedAt: 9 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.detail, 'Between 20 and 400 kg — check the number.');
    assert.equal(error.terminal, true);
    return true;
  });
});

test('deleteBodyweight — 204 for a date with a row and for one without alike', async () => {
  serve(nothing());
  assert.equal(await gymApi.deleteBodyweight('2026-08-26'), null);
  assert.deepEqual(wireOf(calls[0]), { path: '/v1/gym/bodyweight/2026-08-26', method: 'DELETE', credentials: 'include', contentType: 'application/json', body: undefined });
});

test('EXPORT_BODYWEIGHT_HREF — the weigh-ins as their own file, on the same origin', () => {
  assert.equal(EXPORT_BODYWEIGHT_HREF, `${API_BASE}/v1/gym/export/bodyweight`);
  assert.equal(new Set([EXPORT_HREF, EXPORT_THREADS_HREF, EXPORT_NOTES_HREF, EXPORT_BODYWEIGHT_HREF]).size, 4);
});
