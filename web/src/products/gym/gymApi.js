// The one place the gym frontend talks to the backend it was built against. Every call is
// cookie-credentialed (the wm_session the shell already holds) and same-origin in production; in
// dev it points at the local windmill_server. The wire shapes match the backend exactly:
//   GET  /v1/gym/exercises               -> { exercises: [{id, name, pattern, equipment, stepKg, custom}] }
//   POST /v1/gym/exercises               -> {id, name, pattern, equipment, stepKg?} in; the stored
//                                           movement out. A movement a lifter created behaves like
//                                           every other one; an id already spent is 409
//   POST /v1/gym/sessions                -> {id, startedAt, routineId?} in; the OPEN session out —
//                                           idempotent, a replayed or double-tapped start joins the
//                                           open session; an id another account already minted is 409
//   POST /v1/gym/sessions/:id/sets       -> {id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?} in;
//                                           the STORED set out {id, exerciseId, setNumber, weightKg,
//                                           reps, kind, rpe?, note, completedAt}
//   POST /v1/gym/sessions/:id/finish     -> {finishedAt} in; the session out, idempotent
//   GET  /v1/gym/sessions?before=&beforeId=&limit=
//                                        -> { sessions: [{...session, setCount, exercises, topSet?,
//                                           closedItself}] } newest first, keyset-paged on
//                                           (startedAt, id). `topSet` is {weightKg, reps} — the
//                                           heaviest WORKING set, ties to more reps, OMITTED when
//                                           the session holds none — and `closedItself` says the
//                                           four-hour rule closed it rather than a tap. Both are
//                                           the two columns G8 draws on a row and neither can be
//                                           derived from a set COUNT; the list carries no sets, so
//                                           the store answers them where the sets are
//   GET  /v1/gym/sessions/:id            -> { session, sets } — or null on 404 (absent and
//                                           another's are the same byte)
//   DELETE /v1/gym/sessions/:id          -> 204, nothing back — the discard offered at the finish
//                                           screen. A session still running is refused, 409
//   GET  /v1/gym/sessions/:id/review     -> Review — the finish screen read whole
//   GET  /v1/gym/last?exercise=          -> { exerciseId, session?, routine?, sets? } — the prefill:
//                                           the newest FINISHED session holding that movement and
//                                           its working sets in order, warmups excluded
//   GET  /v1/gym/routines                -> { routines: [Routine…] }, most-recently-trained first
//   POST /v1/gym/routines                -> the write document in; the stored Routine out —
//                                           idempotent on the client-minted id, 409 when it is spent
//   GET  /v1/gym/routines/:id            -> Routine — or null on 404, for the session's own reason
//   PUT  /v1/gym/routines/:id            -> the write document in; the stored Routine out. A WHOLE
//                                           document replace, so every edit is a read-modify-write
//   DELETE /v1/gym/routines/:id          -> 204, nothing back
// Sessions serialize as {id, startedAt, finishedAt?, routineId?, plan?}; instants are epoch-ms
// numbers, weights are numbers in kg, and ids are client-minted ('ses_<hex>' / 'set_<hex>' /
// 'rt_<hex>', and 'ex_<hex>' for a movement a lifter mints — the catalog's own are slugs).
// Routines serialize as {id, name, position, lastTrainedAt?, entries: [{position, exerciseId,
// targetSets, targetReps?, targetWeightKg?, restSeconds?}]}, and a write sends that document with
// no `position` on an entry — the entry ORDER is the routine's order and the server renumbers from
// it. A Review is {stats: {durationMs, workingSets, topE1rm?}, slight, record?, against?}. Every
// optional above is OMITTED when it has no value, never null.

import { API_BASE } from '../../shell/apiBase.js';

const base = `${API_BASE}/v1/gym`;

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  return response;
}

async function json(response) {
  // 204 is the one success with nothing to read — both deletes answer it — and asking for bytes
  // that were never sent would turn a success into a parse error.
  if (response.status === 204) return null;
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new GymError(response.status, body?.error ?? '', body?.code ?? '');
}

// A refusal answers with a sentence for a human under "error" and — for the eight reasons a client
// must branch on — a machine word under "code". The code is the contract and the sentence is prose
// that may be reworded any day, so every flag below reads the code. The map is the courtesy: it
// recovers the code from the sentence a refusal shipped with, so classification never depends on
// which of the two fields the server it reached happened to fill in. The first four are the ones
// that ran on servers deployed before the codes existed, and they are why this map is here at all.
const codeForSentence = new Map([
  ['that session is finished', 'session-finished'],
  ['that set id is already used', 'set-id-taken'],
  ['that session id is taken', 'session-id-taken'],
  ['no such exercise', 'unknown-exercise'],
  ['that routine id is taken', 'routine-id-taken'],
  ['that movement id is taken', 'exercise-id-taken'],
  ['that session is still running', 'session-open'],
  ['another session is already open', 'session-already-open'],
]);

// The flush queue's whole retry policy, in one type.
//   400  unreadable or unstorable as written: a bad field, a malformed id, an instant out of
//        bounds, a movement no catalog holds. Terminal — retrying never makes it readable.
//   409  a conflict. Terminal too, and each of the three has its own repair.
//   5xx  the store failed — a dropped connection, a statement timeout, a deadlock. Retryable.
//        A request that never produced a response rejects before this class exists, so a throw
//        that is not a GymError is retryable for the same reason.
//   401 waits for a sign-in, 404 for a session to exist; neither is terminal nor retryable.
// Terminal and retryable never both hold, and neither follows from the other's absence — a queue
// that reads "not retryable" as "lost" throws away a set that was only waiting for a sign-in.
//
// Each code raises the flag that spells it (session-finished → sessionFinished), and each asks the
// caller for a different repair — no English is read to decide which:
//   sessionFinished  409  this set will never land in that session; a new set needs a new session.
//   setIdTaken       409  that set id already names another session's set; mint a fresh id, retry.
//   sessionIdTaken   409  another account minted that session id first; mint a fresh id, retry.
//   unknownExercise  400  no catalog holds that movement; reload the catalog — this body never lands.
//   routineIdTaken   409  that routine id is already spent; mint a fresh id, send the same document.
//   exerciseIdTaken  409  that movement id is already spent; the same repair, on the same terms.
//   sessionOpen      409  the workout is still running. Nothing to repair and nothing to retry now:
//                         only the device holding the offline queue knows every set landed, so a
//                         discard waits for the close rather than destroying sets still in flight.
//   sessionAlreadyOpen 409 a start that said `joinOpenSession: false` — a backfill or an import —
//                         reached a live workout. Nothing to repair either: the past workout waits
//                         for the close rather than filing its sets into today's session.
// Replaying a set that already landed is not a conflict at all: it answers 200 with the stored row
// even after the session is finished, so a flush queue can never drop a durable set.
export class GymError extends Error {
  constructor(status, detail = '', code = '') {
    super(detail || `gym request failed: ${status}`);
    this.name = 'GymError';
    this.status = status;
    this.detail = detail;
    this.code = code || codeForSentence.get(detail) || '';
    this.terminal = status === 400 || status === 409;
    this.retryable = status >= 500;
    this.sessionFinished = this.code === 'session-finished';
    this.setIdTaken = this.code === 'set-id-taken';
    this.sessionIdTaken = this.code === 'session-id-taken';
    this.unknownExercise = this.code === 'unknown-exercise';
    this.routineIdTaken = this.code === 'routine-id-taken';
    this.exerciseIdTaken = this.code === 'exercise-id-taken';
    this.sessionOpen = this.code === 'session-open';
    this.sessionAlreadyOpen = this.code === 'session-already-open';
  }
}

// Why a write did not land, in the half-sentence every surface finishes its own way. A 400 or a 409
// is the store REFUSING the document — it read it and would not take it — and telling a lifter with
// full signal to try again when they have some is the app blaming the network for its own answer,
// on a retry that fails identically forever. Everything else is the log not answering, where
// retrying is the whole of the repair.
export function failureReason(error) {
  if (error?.terminal) return 'the log wouldn’t take it as written';
  return 'the log didn’t answer. Try again when you have signal';
}

export const gymApi = {
  async exercises() {
    return (await json(await call('/exercises'))).exercises;
  },

  // A movement the catalog does not hold, minted by the lifter who wanted it (screen 7). It is a
  // stable identity from the moment it exists, which is the whole reason the picker creates one
  // instead of letting a typed string into a set: a name typed twice is two movements with no
  // history between them.
  async createExercise(exercise) {
    return json(await call('/exercises', { method: 'POST', body: JSON.stringify(exercise) }));
  },

  // The client mints the id and the id IS the idempotency key. Two Starts share this route and they
  // differ only in what the caller means, which is why the caller has to say it: the default JOINS
  // whatever session is open, so a lost race and a borrowed second device both land in the live
  // workout in one round trip (ARCHITECTURE §11.3 — the handoff is free because of this). Pass
  // joinOpenSession: false to mean "create exactly this session, which is not now" — backfill and
  // the Lift import — and a live workout refuses it 409 `session-already-open` instead of handing
  // back today's session for a past workout's sets to be filed into.
  //
  // `routineId` asks the SERVER to freeze that routine onto the session as its plan snapshot. The
  // client never composes the snapshot: a client-composed copy freezes whatever that client last
  // read, which is exactly the staleness the snapshot exists to prevent. A start that joins an
  // already-open session comes back with that session's own snapshot whatever was asked for —
  // pressing Start cannot re-plan a workout that is already running.
  async startSession({ id, startedAt, joinOpenSession = true, routineId }) {
    const body = {
      id,
      startedAt,
      ...(joinOpenSession ? {} : { joinOpenSession: false }),
      ...(routineId === undefined ? {} : { routineId }),
    };
    return json(await call('/sessions', { method: 'POST', body: JSON.stringify(body) }));
  },

  // Converges on exactly one row per minted id — a replay returns the stored set, byte-identical,
  // with its server-assigned number, whether or not the session has since been finished.
  async appendSet(sessionId, set) {
    return json(await call(`/sessions/${sessionId}/sets`, { method: 'POST', body: JSON.stringify(set) }));
  },

  async finishSession(sessionId, { finishedAt }) {
    return json(await call(`/sessions/${sessionId}/finish`, { method: 'POST', body: JSON.stringify({ finishedAt }) }));
  },

  // Paging hands back the last row's startedAt AND its id: two sessions can share an instant, and
  // an instant alone would repeat one across the boundary or skip it. The pair travels together —
  // an id with no instant is a half cursor the server refuses.
  async sessions({ before, beforeId, limit } = {}) {
    const query = new URLSearchParams();
    if (before !== undefined) query.set('before', String(before));
    if (beforeId !== undefined) query.set('beforeId', String(beforeId));
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString();
    return (await json(await call(`/sessions${suffix ? `?${suffix}` : ''}`))).sessions;
  },

  async session(id) {
    const response = await call(`/sessions/${id}`);
    if (response.status === 404) return null;
    return json(response);
  },

  // The finish screen, computed by the store: three facts, at most one record, and the comparison
  // against the last time this routine ran, movement by movement. Every number in it is the
  // domain's — the client renders and decides nothing, so web and iOS cannot disagree about which
  // line is the loud one.
  async review(sessionId) {
    return json(await call(`/sessions/${sessionId}/review`));
  },

  // The one destructive action in the product, and it is offered only after the close: a session
  // still running is refused 409 `session-open`, because only the device holding the offline queue
  // knows every set landed and deleting a workout somebody is still logging into would destroy
  // sets that are in flight.
  async discardSession(id) {
    return json(await call(`/sessions/${id}`, { method: 'DELETE' }));
  },

  async routines() {
    return (await json(await call('/routines'))).routines;
  },

  // Absent and another account's read the same here as they do for a session — one fact, not two.
  async routine(id) {
    const response = await call(`/routines/${id}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async createRoutine(routine) {
    return json(await call('/routines', { method: 'POST', body: JSON.stringify(routine) }));
  },

  // A WHOLE-document replace: what is sent is what the routine becomes, so an edit is a read, a
  // change and a write of everything that came back. Sending only the changed entry deletes the
  // rest of the program (routines.js keeps the modify half of that pure).
  async replaceRoutine(id, routine) {
    return json(await call(`/routines/${id}`, { method: 'PUT', body: JSON.stringify(routine) }));
  },

  async deleteRoutine(id) {
    return json(await call(`/routines/${id}`, { method: 'DELETE' }));
  },

  // The prefill, resolved by the store: the whole history is behind this one read, so the answer
  // never depends on how far the page of sessions in hand happens to reach back.
  //
  // A movement trained for the first time is answered 200 with the movement and nothing else — a
  // fact, not a fault — so the reply is always an object and its `session` is what says whether
  // there is history. Which leaves an absent reply free to mean the only other thing it can: the
  // log has not answered. The one refusal is 400 `unknown-exercise`, the same word the write path
  // uses, and a client that read its ids out of the catalog cannot reach it.
  //
  // The movement is echoed back because the logger re-reads this on every movement change, and a
  // reply that lands after the lifter has moved on has to be discardable.
  async lastTime(exerciseId) {
    return json(await call(`/last?exercise=${encodeURIComponent(exerciseId)}`));
  },
};
