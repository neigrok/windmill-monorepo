// The gym wire contract from the client's side — what each status means to a flush queue that has
// to decide, without a human, whether a set is lost, retryable, or already durable, and which
// machine code tells it how to repair the one that isn't. The sentences here are deliberately not
// the ones the server ships: a refusal reworded overnight must classify the same.
//
// The routine, review and discard routes are here too, with the three refusals they brought. A
// client branches on those by hand rather than in a queue, and it reads them the same way it reads
// the other four: the code, never the English.

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE } from '../../../src/shell/apiBase.js';
import { EXPORT_HREF, failureReason, gymApi, GymError, UNCHANGED } from '../../../src/products/gym/gymApi.js';

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

// A 204 with a body that cannot be parsed, because the client must never try: the two deletes
// answer with no bytes at all, and a reply asked for its json would fail on the success.
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

// THE PICKER'S META, IN ONE READ (§B7) — and the shape of it is the whole contract: the reply
// carries an entry for a movement this account has a LAST TIME for and NOTHING for one it has not.
// The bytes below are read off the writer and the handler rather than off a probe — no server was
// running when this landed, so the claim is only as strong as those two files: `movements` is the
// object's one key (GymApi.cpp::lastSets) and each line is exactly exerciseId · weightKg · reps ·
// at, with no name and no nulls (TrainingJson.cpp::toJson(vector<LastSet>)). The account here has
// two movements behind it and sixty-two it has no last time for; there is no row for those
// sixty-two — no null, no zero, no sentinel — which is what the picker draws `no last time` from,
// and it is why nothing here may fill a gap in.
//
// It takes no arguments. The list is a join key order (ascending id), not a draw order.
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

// A lifter with no finished block behind them is answered with the key present and the list empty,
// which is a whole answer and not a missing one: every row on their picker says `no last time`
// because every row is absent from this list. That is the first-session case — the workout they are
// in right this minute is not a last time until it is over — and it is exactly why the sentence
// those rows draw does not claim they have never trained.
test('lastSets — an account with no history answers an empty list, never an absent one', async () => {
  serve(ok({ movements: [] }));
  assert.deepEqual(await gymApi.lastSets(), []);
});

test('sessions — the pager sends the instant AND the id, and sends neither when unasked', async () => {
  serve(ok({ sessions: [] }));
  assert.deepEqual(await gymApi.sessions(), []);
  assert.deepEqual(wireOf(calls[0]).path, '/v1/gym/sessions');

  // `record` is always on a row and its false is a real answer — a personal record happened in
  // there, or one did not (log.js draws the dot off nothing else).
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

// The mirror's freshness ride: a 200's weak ETag comes back on the reply, goes up again as
// If-None-Match, and the 304 while nothing changed is the UNCHANGED sentinel — never null, which
// already means "no such session" on this same read.
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

// The bytes below are what the running server answered on the probe of this route: the movement
// echoed back, the finished session, the routine frozen in its plan snapshot, and the working sets
// in order with the warmup already dropped.
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

// A movement trained for the first time is a fact, not a fault: the server names it and stops, and
// the answer must survive as an answer — a client that treated it as a failure would show the same
// card for "you have never squatted" as for "the log did not reply".
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

// THE CORRECTION (§G18). The body is the fix and nothing else: an omitted field is left as stored,
// which is the whole reason the rpe and the note this sheet never draws survive it. The stored set
// comes back bare, in the same shape the POST above answers.
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

// A body a fix may not carry is refused whole — the store never ignores a field it will not take,
// so a client that sent `exerciseId` learns it rather than believing a set was moved.
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

// Absent, another account's, already deleted, and this account's set in a DIFFERENT workout are one
// answer and one byte. It is a 404, so neither `terminal` nor `retryable` by status — and it is
// still the end of this edit: there is nothing to retry, and the repair is to read the session.
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

// A FINISHED SESSION IS NOT A REFUSAL ON THIS ROUTE. A lifter reads the log after the workout, which
// is when they see the typo — so there is no `session-finished` here, no `session-open`, and no 409
// at all. The client must never grow a branch for one.
test('fixSet — a set in a session that is over corrects like any other', async () => {
  const stored = {
    id: 'set_3', exerciseId: 'overhead-press', setNumber: 3, weightKg: 47.5, reps: 5,
    kind: 'working', note: '', completedAt: 1_900_000_300_000,
  };
  serve(ok(stored));
  assert.deepEqual(await gymApi.fixSet('ses_closed', 'set_3', { reps: 5 }), stored);
  assert.equal(calls.length, 1);
});

// 204 AND NOTHING BACK, for a set just removed as readily as for one already gone — which is what
// makes a retry after a lost reply safe, and what keeps absent byte-identical to forbidden. The
// reply is never asked for its json: there are no bytes, and asking would turn a success into a
// parse error.
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

// The store failing is the ONE thing a delete can answer besides 204 and a sign-in, and it is
// retryable — which the screen reads as "the set is still in the log" and says so.
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

// The plan snapshot is the SERVER's: `routineId` asks for one, and what comes back is frozen. A
// client that composed the snapshot itself would freeze whatever it last read, which is exactly the
// staleness the snapshot exists to prevent.
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

// Every number on the finish screen arrives computed. The client renders this and decides none of
// it, so web and iOS cannot disagree about which line is the loud one.
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

// ONE MOVEMENT'S PAGE IS ONE READ (§H). No window parameter and no route per block: every number in
// it is the domain's, and a client that could ask for a different window would be a client that
// could ask for a different answer. What the old statistics room read — /v1/gym/stats — is still
// mounted for the agent behind `get_stats`, and this surface no longer calls it at all.
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

  // A chin-up: no estimate anywhere, so the three e1RM-shaped answers are absent TOGETHER, and a
  // movement nobody has worked answers 200 with two counts and nothing else. Neither absence
  // arrives as a null to be mistaken for a zero.
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

// Absent and another account's private movement are ONE fact on this wire, exactly as they are for
// a session and a routine, so a null here says nothing about which.
test('record — a movement that is not this account’s is null, not an error', async () => {
  serve(refusal(404, 'no such movement'));
  assert.equal(await gymApi.record('ex_somebody_elses'), null);

  // And an id with a slash or a space in it is one segment of the path, never two.
  serve(refusal(404, 'no such movement'));
  await gymApi.record('back squat/2');
  assert.equal(wireOf(calls[0]).path, '/v1/gym/exercises/back%20squat%2F2/record');
});

// THE NAME MOVES AND THE IDENTITY DOES NOT. One field goes up, the stored movement comes back under
// the SAME id — which is the promise the record page exists to make visible, and the reason nothing
// in the log has to be rewritten when a lifter renames a lift.
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

  // A name the store will not take is a refusal it READ — terminal, so the repair is a different
  // name and never the same one again when the signal comes back.
  serve(refusal(400, 'could not read that name'));
  const refused = await gymApi.renameExercise('back-squat', '').catch((error) => error);
  assert.equal(refused.status, 400);
  assert.equal(refused.terminal, true);
  assert.equal(refused.retryable, false);
  assert.equal(failureReason(refused), 'the log wouldn’t take it as written');
});

// The mint is idempotent ON THE SESSION — there is no id for a client to send, so tapping Share
// twice is one capability and not two links to revoke separately. Which is why this is a POST with
// no body at all, and why nothing calls it on a render.
test('shareSession — the coach link, minted on a tap, with no document to send', async () => {
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

// THE ONE UNAUTHENTICATED READ. The token is the whole credential, the reply names no account and
// holds no id at any depth, and the movement travels as its display NAME because a reader with no
// account holds no catalog to resolve a slug against.
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

  // Revoked, expired and never-minted are one byte on this wire, so they are one value here: the
  // client may not invent the difference back.
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('revoked'), null);
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('expired'), null);
  serve(refusal(404, 'no such session'));
  assert.equal(await gymApi.sharedSession('never-existed'), null);
});

// The export is not a call at all. Nothing is fetched, parsed or held: the browser follows the link
// and the server's Content-Disposition saves the file, so a log too big for a tab's heap lands.
test('EXPORT_HREF — a link the browser follows, on the same origin as every other gym call', () => {
  assert.equal(EXPORT_HREF, `${API_BASE}/v1/gym/export`);
});

// Only the device holding the offline queue knows every set landed, so a workout somebody is still
// logging into cannot be deleted out from under it — the refusal is a fact about the session, not
// about the request, and the client branches on the code to say so.
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

// A write carries the entry ORDER and no entry positions; what comes back carries both, because the
// store numbered them. PUT replaces the whole document, which is why the editor reads before it
// writes — sending one changed entry would delete the rest of the program.
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

// A ROUTINE CARRIES THE PROPOSAL WAITING ON IT. The card on Today and the dot on the routines list
// are drawn out of this read and no other — a proposal always targets a routine, so the read those
// rooms were already making is the read that answers "is anything waiting". `revision` rides along
// and is READ-ONLY: it is what a proposal is frozen against, and this client never sends one.
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

  // A routine with nothing waiting carries no key at all — an omission, never a null, exactly as
  // every other optional on this wire.
  const quiet = { id: 'rt_pull_a', name: 'Pull A', position: 1, revision: 1, entries: [] };
  serve(ok({ routines: [quiet] }));
  assert.deepEqual(await gymApi.routines(), [quiet]);
  assert.equal('pendingProposal' in quiet, false);
});

// THE ROUTINE'S DATED HISTORY (screen 6), and the whole ledger when nothing is asked of it. `state`
// recognises the literal "pending" and nothing else, so a client that guessed a word gets the whole
// history rather than an empty screen.
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

// ONE PROPOSAL, WHOLE: the head, the base it was written against, and the change rows that are the
// document as well as the diff. Absent and another account's are one fact here as they are for a
// session, a routine and a movement.
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

// THE TAP, AND IT CARRIES NO DOCUMENT. The proposal is what was written and frozen; a client that
// could send fields here would be a client that could apply something the lifter never read. What
// comes back is the settled proposal AND the routine as it now stands, so the screen redraws off the
// store rather than off what it hoped had happened.
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

  // A removal that landed has no routine to hand back — the key is absent, not null.
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

// THE TWO WAYS THE WORLD MOVES UNDER A DIFF, and both are terminal. `proposal-superseded` is the
// human's own hand winning — the routine was saved after the proposal was written, so its base is
// gone and NOTHING from it was applied. `proposal-settled` is the other decision already taken, on
// another tab or on a phone. Neither is repairable by sending the same request again, and a client
// that read either as a network failure would offer a retry that fails identically forever.
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

// A proposal that is gone is a bare 404 with no code — absent, another account's and never-existed
// are one fact, exactly as they are on every other read here. It is neither terminal nor retryable
// by status, and the screen reads the status: after a lifter's OWN apply of a removal it is a
// SUCCESS, because the routine went and its ledger row went with it.
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

// §I's five settings. THE READ NEVER 404s — a lifter with nothing stored is served the defaults —
// so there is no null branch here at all, which is the whole difference between this route and every
// other read in this file.
test('preferences — one read that always answers, and a whole-document write that answers with the store’s copy', async () => {
  const stored = {
    units: 'kg',
    barWeightKg: 20,
    platesKg: [25, 20, 2.5],
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

  // Sent unsorted, answered heaviest-first: the store normalises, and the screen draws what came
  // back rather than what it hoped it sent.
  const write = { ...stored, platesKg: [2.5, 25, 20] };
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

// Six refusals, all 400 and all carrying a code. Nothing here branches on one — the SENTENCE is what
// the lifter is shown, because it names the band the value fell outside — but a refusal must still
// arrive as a terminal GymError with the code intact, because a client that read it as a network
// failure would offer a retry that fails identically forever.
test('preferences — every refusal is terminal, keeps its code, and carries the band in words', async () => {
  const refusals = [
    ['preferences-unreadable', 'that isn’t a settings document'],
    ['unknown-unit', 'units are "kg" or "lb"'],
    ['bar-weight', 'a bar weighs from 0 to 100 kg'],
    ['plate-weight', 'a plate weighs from 0.01 to 100 kg'],
    ['too-many-plates', 'a gym holds at most 12 kinds of plate'],
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

// The two id conflicts share one repair — mint another and send the same document again — and they
// are told apart only by which id was spent. A client that read "409" alone would have to guess.
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

// A routine entry naming a movement no catalog holds is the WRITE path's refusal, reused: the same
// code the queue already repairs by reloading the catalog, and the same 400 that says this body
// never lands however many times it is sent.
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

// The map is exhaustive on purpose: classification never depends on which of the two fields the
// server it reached happened to fill in, so a refusal that arrives as a sentence alone raises the
// same flag as the one that arrives with its code.
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

// THE EIGHTH CODED REFUSAL, which had no flag and no sentence in the map. It is what a start
// carrying `joinOpenSession: false` gets when a workout is running — the backfill form's own
// request — and the only way to tell it apart from `session-id-taken` was the status both share, so
// a colliding id spoke the mid-workout refusal's words and a stale tab could read either as either.
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
  // The one it used to be indistinguishable from, on the same status.
  serve(refusal(409, 'that session id is taken', 'session-id-taken'));
  await assert.rejects(() => gymApi.startSession({ id: 'ses_1', startedAt: 1, joinOpenSession: false }), (error) => {
    assert.equal(error.sessionAlreadyOpen, false);
    assert.equal(error.sessionIdTaken, true);
    return true;
  });
});

// A 400 or a 409 is the store REFUSING the document, and telling a lifter with full signal to try
// again when they have some is the app blaming the network for its own answer — on a retry that
// fails identically forever.
test('failureReason — a refusal and a silence do not get the same sentence', async () => {
  assert.equal(failureReason(new GymError(400, 'a routine needs at least one movement')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(409, 'that routine id is taken', 'routine-id-taken')), 'the log wouldn’t take it as written');
  assert.equal(failureReason(new GymError(503, '')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(new GymError(401, '')), 'the log didn’t answer. Try again when you have signal');
  // A request that never produced a response rejects before a GymError exists at all.
  assert.equal(failureReason(new TypeError('Failed to fetch')), 'the log didn’t answer. Try again when you have signal');
  assert.equal(failureReason(undefined), 'the log didn’t answer. Try again when you have signal');
});
