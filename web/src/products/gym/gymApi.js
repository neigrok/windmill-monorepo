// The one place the gym frontend talks to the backend it was built against. Every call is
// cookie-credentialed (the wm_session the shell already holds) and same-origin in production; in
// dev it points at the local windmill_server. The wire shapes match the backend exactly:
//   GET  /v1/gym/exercises               -> { exercises: [{id, name, pattern, equipment, stepKg, custom}] }
//   POST /v1/gym/sessions                -> {id, startedAt} in; the OPEN session out — idempotent,
//                                           a replayed or double-tapped start joins the open session;
//                                           an id another account already minted is refused, 409
//   POST /v1/gym/sessions/:id/sets       -> {id, exerciseId, weightKg, reps, completedAt, kind?, rpe?, note?} in;
//                                           the STORED set out {id, exerciseId, setNumber, weightKg,
//                                           reps, kind, rpe?, note, completedAt}
//   POST /v1/gym/sessions/:id/finish     -> {finishedAt} in; the session out, idempotent
//   GET  /v1/gym/sessions?before=&beforeId=&limit=
//                                        -> { sessions: [{...session, setCount, exercises}] }
//                                           newest first, keyset-paged on (startedAt, id)
//   GET  /v1/gym/sessions/:id            -> { session, sets } — or null on 404 (absent and
//                                           another's are the same byte)
//   GET  /v1/gym/last?exercise=          -> { exerciseId, session?, routine?, sets? } — the prefill:
//                                           the newest FINISHED session holding that movement and
//                                           its working sets in order, warmups excluded
// Sessions serialize as {id, startedAt, finishedAt?, routineId?, plan?}; instants are epoch-ms
// numbers, weights are numbers in kg, ids are client-minted ('ses_<hex>' / 'set_<hex>').

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
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new GymError(response.status, body?.error ?? '', body?.code ?? '');
}

// A refusal answers with a sentence for a human under "error" and — for the four reasons a client
// must branch on — a machine word under "code". The code is the contract and the sentence is prose
// that may be reworded any day, so every flag below reads the code. The map is the courtesy: it
// recovers the same four from the sentences they shipped with, so a client running against a server
// deployed before the codes still classifies correctly. It goes when no such server is left.
const codeForSentence = new Map([
  ['that session is finished', 'session-finished'],
  ['that set id is already used', 'set-id-taken'],
  ['that session id is taken', 'session-id-taken'],
  ['no such exercise', 'unknown-exercise'],
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
  }
}

export const gymApi = {
  async exercises() {
    return (await json(await call('/exercises'))).exercises;
  },

  // The client mints the id and the id IS the idempotency key: the reply is whichever session is
  // open for this account after the insert, so a lost race still sees the truth in one round trip.
  async startSession({ id, startedAt }) {
    return json(await call('/sessions', { method: 'POST', body: JSON.stringify({ id, startedAt }) }));
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
