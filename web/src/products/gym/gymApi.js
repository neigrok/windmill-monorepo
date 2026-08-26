// The gym frontend's calls to the backend. Cookie-credentialed, same-origin.
//   GET   /v1/gym/exercises -> {exercises: [{id, name, pattern, equipment, stepKg, custom, aliases?}]};
//         `aliases` is omitted when there are none, never [].
//   GET   /v1/gym/exercises/last -> {movements: [{exerciseId, weightKg, reps, at}]}; sparse — no entry
//         is the "no last time". The open session and warmups are excluded. The entry is the LAST set
//         of that movement's last-time block, not the heaviest; `at` is that session's start.
//   POST  /v1/gym/exercises -> {id, name, pattern, equipment, stepKg?} in, the stored movement out;
//         409 on a spent id.
//   PATCH /v1/gym/exercises/:id -> {name} in, any other key 400; the stored movement out under the
//         same id with its new `aliases`.
//   GET   /v1/gym/exercises/:id/record -> {exercise, routineCount, routines?, sessionCount, bestE1rm?,
//         heaviest?, e1rmSeries?, records?, recentDays?}, or null on 404. Counts are always present
//         and a zero is real; lists are omitted when empty. `bestE1rm`, `e1rmSeries` and `records` are
//         absent together where Epley is undefined. `e1rmSeries` is oldest first over twelve weeks,
//         one point per session; `records` and `recentDays` newest first, warmups excluded.
//   POST  /v1/gym/sessions -> {id, startedAt, joinOpenSession?, routineId?} in, the open session out;
//         idempotent, a replayed start joins the open session, 409 for another account's id.
//         joinOpenSession:false is refused 409 `session-already-open` while a workout is running.
//         `routineId` asks the server to freeze that routine onto the session as its plan.
//   POST  /v1/gym/sessions/:id/sets -> {id, exerciseId, weightKg, reps, completedAt, kind?, rpe?,
//         note?} in; {id, exerciseId, setNumber, weightKg, reps, kind, rpe?, note, completedAt} out.
//         A replay answers 200 with the stored row, finished session or not.
//   PATCH /v1/gym/sessions/:id/sets/:setId -> {weightKg?, reps?, kind?, rpe?, note?}; an omitted field
//         is left as stored, a null `rpe` clears it, "" clears a note, {} is legal. Any other key 400.
//         400 `fix-unreadable`; 404 `set-not-found` for absent, another account's, deleted, or this
//         account's set in a different workout.
//   DELETE /v1/gym/sessions/:id/sets/:setId -> 204, for a set already gone and another account's
//         alike. Set numbers are never reissued: a delete leaves a gap.
//   POST  /v1/gym/sessions/:id/finish -> {finishedAt} in, the session out, idempotent.
//   GET   /v1/gym/sessions?before=&beforeId=&limit= -> {sessions: [{...session, setCount,
//         workingSetCount, tonnageKg, exercises, topSet?, topE1rm?, closedItself, record}]}, newest
//         first, keyset-paged on (startedAt, id) — both or neither. The list carries no sets.
//         `tonnageKg` sums working weight × reps with assisted sets clamped to zero, always present;
//         `topSet` is {weightKg, reps}, the heaviest working set with ties to more reps, omitted when
//         there is none; `topE1rm` is the best Epley over every working set. `closedItself` says the
//         four-hour rule closed the session; `record` is judged against the log as it is now.
//   GET   /v1/gym/sessions/:id -> {session, sets}, or null on 404. Carries a weak ETag; echoing it as
//         If-None-Match is answered 304 with no body.
//   DELETE /v1/gym/sessions/:id -> 204; a session still running is refused 409 `session-open`.
//   GET   /v1/gym/sessions/:id/review -> Review.
//   GET   /v1/gym/last?exercise= -> {exerciseId, session?, routine?, sets?}: the newest FINISHED
//         session holding that movement and its working sets in order, warmups excluded. Always an
//         object — `session` is what says whether there is history.
//   POST  /v1/gym/sessions/:id/share -> {token, expiresAt}, minted or the live one handed back;
//         idempotent on the session, no client-minted id.
//   DELETE /v1/gym/sessions/:id/share -> 204; a 404 is nothing to revoke and reads as revoked.
//   GET   /v1/gym/shared/:token -> {startedAt, finishedAt?, routine?, sets: [{exercise, setNumber,
//         weightKg, reps, kind, rpe?, note, completedAt}]}, or null on 404. The one unauthenticated
//         read; revoked, expired and never-minted answer the same byte.
//   POST  /v1/gym/ask -> {thread, question} in, the thread id client-minted ('thr_<hex>', a fresh one
//         opening a conversation); {answer, steps: [{tool, failed}], read: {sets, sessions, weeks},
//         proposals: [id…], thread} out. `steps` is the tools the model asked for, in call order;
//         `read` is server-counted and may not be summed or inferred here; `proposals` is the ids
//         minted during the exchange, in mint order. A bare 404 means no Coach on this
//         deployment. 429 `ask-daily-limit` and `ask-out-of-budget`; 409 `ask-session-open`,
//         `ask-thread-taken`, `ask-thread-full` at eight stored turns; 400 for a malformed thread id,
//         a blank question or one over 1000 bytes. A 502 stored nothing. The `ask-*` codes and the
//         route are machine tokens and keep their spelling; the room is Coach.
//   GET   /v1/gym/notes -> {notes: [{id, position, title, body, updatedAt}]}, position ascending and
//         contiguous from 0; an account with none is served {notes: []}.
//   PUT   /v1/gym/notes/:id -> {title, body} in, {note} out; an upsert on the client-minted id
//         ('note_<hex>'), a new id appended last. 400 with the store's sentence for an empty title,
//         a title past 60 characters, a body past 500 UTF-8 bytes or an unreadable note; 409
//         `notes-full` at ten, 409 `note-id-taken` for another account's id.
//   DELETE /v1/gym/notes/:id -> 204, for a note already gone alike; the rest close the gap.
//   PUT   /v1/gym/notes -> {order: [id…]} in, {notes} out; a whole-order replace that must name
//         every note once, or 400 `notes-order-mismatch`.
//   GET   /v1/gym/bodyweight[?from=&to=] -> {entries: [{dateLocal, weightKg, recordedAt}], latest};
//         entries ascending by `dateLocal` ('YYYY-MM-DD', the lifter's own calendar date), both
//         bounds inclusive and absent for the whole series; `latest` is the newest date's entry or
//         null. 400 for a bound that is not a date.
//   PUT   /v1/gym/bodyweight/:dateLocal -> {weightKg, recordedAt} in, {entry} out. One row per
//         local date and the write is idempotent by it; where a row already stands the newer
//         `recordedAt` wins, so a stale replay answers 200 with the stored row unchanged. 400 with
//         the store's sentence for a date that is not one, a weight outside 20–400 kg, or a body it
//         cannot read. Kilograms only, two decimals.
//   DELETE /v1/gym/bodyweight/:dateLocal -> 204, for a date with no row alike.
//   GET   /v1/gym/threads -> {threads: [Thread…]}, newest `askedAt` first, at most 200.
//   GET   /v1/gym/threads/:id -> one Thread carrying `turns`, the only read that does, or null on 404.
//   DELETE /v1/gym/threads/:id -> 204. A proposal it minted keeps `source.door: 'ask'` and loses
//         `source.thread`.
//   GET   /v1/gym/preferences -> the settings document; never 404s, an account with no row is served
//         the defaults.
//   PUT   /v1/gym/preferences -> the whole document in, the stored document out. A replace and not a
//         merge: an omitted field takes its DEFAULT. An absent `restSeconds` is the only way to say
//         the rest timer is off. 400 preferences-unreadable, unknown-unit, rest-target, and nothing
//         lands on a refusal. Units are display only; every weight on every route is kilograms.
//   GET   /v1/gym/routines -> {routines: [Routine…]}, most-recently-trained first, carrying no history.
//   POST  /v1/gym/routines -> the write document in, the stored Routine out; idempotent on the
//         client-minted id, 409 when it is spent.
//   GET   /v1/gym/routines/:id -> Routine, or null on 404. The only read carrying `history`: rows
//         newest first, each {kind:'created', at, by?, movements?} or {kind:'proposal', at, proposal}.
//         The created row is always present and always last. `by` absent is the lifter's own hand,
//         present it names an agent's door. `movements` is how many lines the routine was created
//         with, absent where none was stored.
//   PUT   /v1/gym/routines/:id -> the write document in, the stored Routine out; a whole-document
//         replace, so every edit is a read-modify-write and a rename is this route.
//   DELETE /v1/gym/routines/:id -> 204.
//   GET   /v1/gym/proposals[?routineId=&state=pending] -> {proposals: [head…]}, newest first. `state`
//         recognises the literal "pending" and nothing else; any other value is unfiltered.
//   GET   /v1/gym/proposals/:id -> the head plus `baseRevision`, `baseName`, `name` and the `changes`
//         rows, or null on 404.
//   POST  /v1/gym/proposals/:id/apply -> {proposal, routine?}; atomic against the frozen
//         `baseRevision`, all of the document or none. `routine` is absent when the intent was
//         `remove`, and a 404 answering an apply of one is a success — the routine and its ledger went.
//   POST  /v1/gym/proposals/:id/dismiss -> {proposal}.
// Both settlements replay: the decision already taken answers 200 with the settled proposal. The
// refusals are 409 `proposal-superseded`, 409 `proposal-settled` and a bare 404.
// A Thread is {id, title, createdAt, askedAt, outcome, proposals: [head-ish…], turns?}. `title` is the
// lifter's first message verbatim; no surface may summarise it. `outcome` is server-derived
// {kind: 'read-only'|'proposed'|'applied'|'dismissed'|'superseded', changes, routineId?, routine?},
// where the routine pair is omitted together when the changes spanned more than one. A `proposals` row
// is {id, state, changeCount, routineId, routine, createdAt}; a turn is {from: 'lifter'|'ask', text, at}.
// Sessions serialize as {id, startedAt, finishedAt?, routineId?, plan?}; instants are epoch-ms numbers,
// weights are kg, and ids are client-minted ('ses_<hex>' / 'set_<hex>' / 'rt_<hex>', 'ex_<hex>' for a
// lifter's own movement — the catalog's are slugs). A proposal's id ('prop_<hex>') is never minted here.
// Routines serialize as {id, name, position, revision, lastTrainedAt?, pendingProposal?, history?,
// entries: [{position, exerciseId, targetSets?, targetReps?, targetWeightKg?, restSeconds?}]}; a write
// sends no `position` on an entry and the server renumbers from the entry order.
// An entry with no `targetSets` is open: it must carry no `targetReps` and no `targetWeightKg` or the
// write is refused 400, and `restSeconds` is allowed on one. Bounds when named: sets 1–20, reps 1–100,
// weight ±500 kg, rest 15–900 s, one to fifty entries per routine. No `lastTrainedAt` is `untested`.
// `revision` is the store's to move and is what a proposal is frozen against. `pendingProposal` is a
// head — {id, routineId, intent, state, summary, changeCount, createdAt, settledAt?, source: {door,
// connection?, agent?, thread?}} — present only while one is waiting; `source.thread` is offered only
// when present.
// A Review is {stats: {durationMs, workingSets, topE1rm?}, slight, record?, against?}. Every optional
// is omitted when it has no value, never null.

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
  if (response.status === 204) return null;
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new GymError(response.status, body?.error ?? '', body?.code ?? '');
}

// Recovers the machine code from the sentence, for servers that send only the sentence.
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

// The flush queue's retry policy: 400 and 409 are terminal, 5xx retryable, and 401 and 404 neither.
// Repairs, decided off the code and never off the sentence: setIdTaken / sessionIdTaken /
// routineIdTaken / exerciseIdTaken — mint a fresh id and retry the same body; unknownExercise —
// reload the catalog; sessionFinished — a new set needs a new session; sessionOpen and
// sessionAlreadyOpen — wait for the open workout to close; fixUnreadable — those bytes never land;
// setNotFound — drop the pending edit and read the session again; proposalSuperseded and
// proposalSettled — re-read.
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
    this.fixUnreadable = this.code === 'fix-unreadable';
    this.setNotFound = this.code === 'set-not-found';
    this.proposalSuperseded = this.code === 'proposal-superseded';
    this.proposalSettled = this.code === 'proposal-settled';
  }
}

export function failureReason(error) {
  if (error?.terminal) return 'the log wouldn’t take it as written';
  if (error?.status === 401) return 'you’re signed out. Sign in and try again';
  if (error?.status === 404) return 'it isn’t in the log any more';
  return 'the log didn’t answer. Try again when you have signal';
}

// What a 304 hands back; null already means "no such session" on the same read.
export const UNCHANGED = Symbol('gym-session-unchanged');

export const gymApi = {
  async exercises() {
    return (await json(await call('/exercises'))).exercises;
  },

  async lastSets() {
    return (await json(await call('/exercises/last'))).movements;
  },

  async createExercise(exercise) {
    return json(await call('/exercises', { method: 'POST', body: JSON.stringify(exercise) }));
  },

  async renameExercise(exerciseId, name) {
    return json(await call(`/exercises/${encodeURIComponent(exerciseId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }));
  },

  async record(exerciseId) {
    const response = await call(`/exercises/${encodeURIComponent(exerciseId)}/record`);
    if (response.status === 404) return null;
    return json(response);
  },

  async startSession({ id, startedAt, joinOpenSession = true, routineId }) {
    const body = {
      id,
      startedAt,
      ...(joinOpenSession ? {} : { joinOpenSession: false }),
      ...(routineId === undefined ? {} : { routineId }),
    };
    return json(await call('/sessions', { method: 'POST', body: JSON.stringify(body) }));
  },

  async appendSet(sessionId, set) {
    return json(await call(`/sessions/${sessionId}/sets`, { method: 'POST', body: JSON.stringify(set) }));
  },

  async fixSet(sessionId, setId, fix) {
    return json(await call(`/sessions/${sessionId}/sets/${setId}`, {
      method: 'PATCH',
      body: JSON.stringify(fix),
    }));
  },

  async deleteSet(sessionId, setId) {
    return json(await call(`/sessions/${sessionId}/sets/${setId}`, { method: 'DELETE' }));
  },

  async finishSession(sessionId, { finishedAt }) {
    return json(await call(`/sessions/${sessionId}/finish`, { method: 'POST', body: JSON.stringify({ finishedAt }) }));
  },

  async sessions({ before, beforeId, limit } = {}) {
    const query = new URLSearchParams();
    if (before !== undefined) query.set('before', String(before));
    if (beforeId !== undefined) query.set('beforeId', String(beforeId));
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.toString();
    return (await json(await call(`/sessions${suffix ? `?${suffix}` : ''}`))).sessions;
  },

  async session(id, { etag } = {}) {
    const response = await call(`/sessions/${id}`, etag ? { headers: { 'if-none-match': etag } } : {});
    if (response.status === 404) return null;
    if (response.status === 304) return UNCHANGED;
    const tag = response.headers?.get('etag');
    const detail = await json(response);
    return tag ? { ...detail, etag: tag } : detail;
  },

  async review(sessionId) {
    return json(await call(`/sessions/${sessionId}/review`));
  },

  async discardSession(id) {
    return json(await call(`/sessions/${id}`, { method: 'DELETE' }));
  },

  async preferences() {
    return json(await call('/preferences'));
  },

  async savePreferences(document) {
    return json(await call('/preferences', { method: 'PUT', body: JSON.stringify(document) }));
  },

  async routines() {
    return (await json(await call('/routines'))).routines;
  },

  async routine(id) {
    const response = await call(`/routines/${id}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async createRoutine(routine) {
    return json(await call('/routines', { method: 'POST', body: JSON.stringify(routine) }));
  },

  async replaceRoutine(id, routine) {
    return json(await call(`/routines/${id}`, { method: 'PUT', body: JSON.stringify(routine) }));
  },

  async deleteRoutine(id) {
    return json(await call(`/routines/${id}`, { method: 'DELETE' }));
  },

  async proposals({ routineId, state } = {}) {
    const query = new URLSearchParams();
    if (routineId !== undefined) query.set('routineId', routineId);
    if (state !== undefined) query.set('state', state);
    const suffix = query.toString();
    return (await json(await call(`/proposals${suffix ? `?${suffix}` : ''}`))).proposals;
  },

  async proposal(id) {
    const response = await call(`/proposals/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async applyProposal(id) {
    return json(await call(`/proposals/${encodeURIComponent(id)}/apply`, { method: 'POST' }));
  },

  async dismissProposal(id) {
    return json(await call(`/proposals/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }));
  },

  async lastTime(exerciseId) {
    return json(await call(`/last?exercise=${encodeURIComponent(exerciseId)}`));
  },

  async shareSession(id) {
    return json(await call(`/sessions/${id}/share`, { method: 'POST' }));
  },

  async revokeShare(id) {
    const response = await call(`/sessions/${id}/share`, { method: 'DELETE' });
    if (response.status === 404) return null;
    return json(response);
  },

  async sharedSession(token) {
    const response = await call(`/shared/${encodeURIComponent(token)}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async ask(thread, question) {
    return json(await call('/ask', { method: 'POST', body: JSON.stringify({ thread, question }) }));
  },

  async threads() {
    return (await json(await call('/threads'))).threads;
  },

  async thread(id) {
    const response = await call(`/threads/${encodeURIComponent(id)}`);
    if (response.status === 404) return null;
    return json(response);
  },

  async deleteThread(id) {
    return json(await call(`/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

  async notes() {
    return (await json(await call('/notes'))).notes;
  },

  async saveNote(id, note) {
    return (await json(await call(`/notes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(note),
    }))).note;
  },

  async deleteNote(id) {
    return json(await call(`/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  },

  async reorderNotes(order) {
    return (await json(await call('/notes', { method: 'PUT', body: JSON.stringify({ order }) }))).notes;
  },

  async bodyweight({ from, to } = {}) {
    const query = new URLSearchParams();
    if (from !== undefined) query.set('from', from);
    if (to !== undefined) query.set('to', to);
    const suffix = query.toString();
    return json(await call(`/bodyweight${suffix ? `?${suffix}` : ''}`));
  },

  async saveBodyweight(dateLocal, { weightKg, recordedAt }) {
    return (await json(await call(`/bodyweight/${encodeURIComponent(dateLocal)}`, {
      method: 'PUT',
      body: JSON.stringify({ weightKg, recordedAt }),
    }))).entry;
  },

  async deleteBodyweight(dateLocal) {
    return json(await call(`/bodyweight/${encodeURIComponent(dateLocal)}`, { method: 'DELETE' }));
  },
};

// Links the browser follows, not methods; the session cookie rides the navigation.
export const EXPORT_HREF = `${base}/export`;
export const EXPORT_THREADS_HREF = `${base}/export/threads`;
export const EXPORT_NOTES_HREF = `${base}/export/notes`;
export const EXPORT_BODYWEIGHT_HREF = `${base}/export/bodyweight`;
