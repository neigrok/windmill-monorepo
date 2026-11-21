// §7.4 the sender: numbering ready entries into a push, and the push response, one local transaction
// per result. Timing {send, recv} is the device clocks' readings around the request, for the offset
// sample (§10.4).

import { CONSTANTS } from '../core/constants.js';
import { moveEntry } from '../core/machines.js';
import { ReceiptError, receiptEffects } from '../core/receipts.js';
import { InverseOutcomesError } from '../core/restore.js';
import { stampsOf } from '../core/rows.js';
import { bodyBytes, intentDigest } from '../core/wire.js';
import { Dependents, scopedKey } from './dependents.js';
import { applyInverseResult, checkInverseResult, passesBarrier, resolveReferences } from './inverse.js';
import { retainOutcome } from './journal.js';
import { epochChange, reidentify, renewActor } from './lifecycle.js';
import { resolveIfCovered } from './puller.js';
import { applyAcceptedVersions, applyWriteMap, onRefused, refuseOutgrown } from './refusal.js';
import { effectsOf, mergePredictions } from './projections.js';

// §7.4 held back: the ready entries that depend (§7.7 step 3) on a held or held-back entry or on an
// orphan awaiting its result (sent, or returned to ready), or touch a record an earlier held-back entry
// touches, by a delta, a guard or a prediction.
function heldBack(replica, registry) {
  const sources = new Dependents(registry);
  const touched = new Set();
  const back = new Set();
  for (const entry of replica.entries()) {
    if (entry.state === 'ready') {
      const records = [...effectsOf(entry).flatMap(({ scope, d }) => d.map((target) => scopedKey(scope, target.t, target.id))),
        ...(entry.intent.guard ?? []).map((guard) => scopedKey(entry.scope, guard.t, guard.id))];
      if (sources.of(entry).any || records.some((record) => touched.has(record))) {
        back.add(entry);
        for (const record of records) touched.add(record);
      }
    }
    const awaiting = entry.orphanOf !== undefined && (entry.state === 'sent' || entry.state === 'ready');
    if (entry.state === 'held' || back.has(entry) || awaiting) sources.absorbEntry(entry);
  }
  return back;
}

// Numbers ready entries in commit order up to PUSH_MAX_INTENTS and while the request body, its jcs,
// stays within PUSH_MAX_BYTES (the first entry of a request always goes), passing over held-back
// entries, stopping after the first command entry or at a held-back one, and never while a command
// entry is sent. An entry that no longer fits a request alone is refused instead of numbered; the
// entries its fold ends or changes, and the held-back set its end changes, are read afresh. `limit`
// (after a several-intent 400 or 413) sends at most that many sent entries and numbers none beyond
// them. Answers the push request, or null.
export function nextPush(replica, ctx, { limit } = {}) {
  const limits = ctx.limits ?? CONSTANTS;
  const maxIntents = Math.min(limits.PUSH_MAX_INTENTS, limit ?? Infinity);
  const { meta } = replica;
  if (meta.state !== 'bound' || meta.authPaused) return null;
  const sent = () => replica.entries().filter((entry) => entry.state === 'sent').sort((a, b) => a.n - b.n);
  if (!sent().some((entry) => entry.intent.cmd !== undefined)) {
    const intents = sent().map((entry) => entry.intent);
    let back = heldBack(replica, ctx.registry);
    for (const entry of replica.entries().filter((candidate) => candidate.state === 'ready')) {
      if (replica.entry(entry.localId) !== entry || entry.state !== 'ready') continue;
      if (entry.inverseOf !== undefined) {
        if (!passesBarrier(replica, ctx, entry)) break;
        back = heldBack(replica, ctx.registry);
        if (replica.entry(entry.localId) !== entry) continue;
      }
      if (back.has(entry)) {
        if (entry.intent.cmd !== undefined) break;
        continue;
      }
      const intent = { ...entry.intent, n: meta.nextN };
      const bytesWith = (batch) => bodyBytes(pushRequest(meta, batch));
      if (bytesWith([intent]) > limits.PUSH_MAX_BYTES) {
        refuseOutgrown(replica, ctx, entry);
        back = heldBack(replica, ctx.registry);
        continue;
      }
      const fits = bytesWith([...intents, intent]) <= limits.PUSH_MAX_BYTES;
      if (intents.length >= maxIntents || (intents.length > 0 && !fits)) break;
      entry.intent = intent;
      entry.n = meta.nextN;
      entry.digest = intentDigest(intent);
      moveEntry(replica, ctx.ended, entry, 'number');
      meta.nextN += 1;
      intents.push(intent);
      if (intent.cmd !== undefined) break;
    }
  }
  const batch = sent().slice(0, maxIntents);
  if (batch.length === 0) return null;
  return pushRequest(meta, batch.map((entry) => entry.intent));
}

// §9.3: a push names the replica and the account it is bound to (§6.2 step 3).
function pushRequest(meta, intents) {
  return { replica: meta.replica, account: meta.account, ackThrough: meta.ackThrough, intents };
}

// A push response, its results in ascending n, in batches of any size (each result here). A replica that
// holds no epoch takes the answer's in its first batch (with no result, in the one that sets
// ackThrough), so no entry is acked under a null serverEpoch.
// After a 400 or 413 on several intents it answers {limit}, ⌈count/2⌉, which the caller's next nextPush
// passes to resend the first half by n; otherwise nothing. Every 400, and a 200 with an unreadable receipt,
// emits sync-push-malformed. After a 409 or an epoch change the instance takes a new actor (§7.11). A 401,
// or a 200 or 409 served as anyone but the replica's account, pauses sync with nothing applied (§9.1). With `dieAfter`, the process dies
// once that many results are recorded: the rest stay sent and ackThrough holds. A changed epoch
// records safe successes and resets together, before ordinary result batches.
export class ResponseError extends Error {}

export function validatePushEnvelope({ status, body }) {
  if (typeof body?.epoch !== 'string' || body.epoch.length === 0
    || !Number.isSafeInteger(body.serverTime) || body.serverTime < 0) throw new ResponseError('invalid sync response');
  if (status === 409 && !['gap', 'replica-forked', 'replica-foreign'].includes(body.error))
    throw new ResponseError('invalid sync response');
  if (status === 200 && (!Number.isSafeInteger(body.lastN) || body.lastN < 0 || !Array.isArray(body.results)))
    throw new ResponseError('invalid sync response');
  if (status === 200 && body.retry !== undefined && (!Number.isSafeInteger(body.retry?.n) || body.retry.n < 1
    || body.retry.n > body.lastN + 1 || !Number.isSafeInteger(body.retry.retryAfterMs) || body.retry.retryAfterMs < 0
    || body.results.some((result) => result.n >= body.retry.n))) throw new ResponseError('invalid sync continuation');
}

// Each result is checked against the entry it will apply to, the sent entry at its n: an entry acknowledged
// under an earlier replica id keeps its old n until it settles, and is never the one a result answers. A
// response over SCOPED_RESPONSE_MAX_BYTES that answers a scoped entry is a transport failure; an `ok` whose
// receipt or inverse outcomes fail their check is unreadable, and answers its n in the set returned.
export function validatePushReceipts(replica, registry, body) {
  const unreadable = new Set();
  for (const result of body.results) {
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
    if (!entry || result.s !== 'ok') continue;
    if (entry.predictions && bodyBytes(body) > CONSTANTS.SCOPED_RESPONSE_MAX_BYTES) throw new ResponseError('scoped response too large');
    try {
      checkInverseResult(replica, entry, result);
      if (entry.predictions) receiptEffects(registry, entry, result);
      else if (result.detail?.windmillKit !== undefined) throw new ReceiptError('unexpected scoped receipt');
    } catch (error) {
      if (!(error instanceof ReceiptError || error instanceof InverseOutcomesError)) throw error;
      unreadable.add(result.n);
    }
  }
  return unreadable;
}

export function onPushResponse(replica, ctx, request, response, timing, { dieAfter = Infinity } = {}) {
  const { meta } = replica;
  const { status, body } = response;
  const unauthenticated = replica.isUnauthenticated(response);
  if ((status === 200 || status === 409) && !unauthenticated) validatePushEnvelope(response);
  const unreadable = status === 200 && !unauthenticated ? validatePushReceipts(replica, ctx.registry, body) : new Set();
  if (body?.serverTime !== undefined) replica.takeOffsetSample(body.serverTime, timing, ctx.limits);
  if (unauthenticated) {
    meta.authPaused = true;
    return undefined;
  }
  if (unreadable.size) ctx.telemetry.push({ event: 'sync-push-malformed' });
  if ((status === 200 || status === 409) && meta.serverEpoch !== null && body.epoch !== meta.serverEpoch) {
    if (status === 200 && !replica.entries().some((entry) => entry.state === 'acked' && entry.resultEpoch !== body.epoch)) {
      for (const result of [...body.results].sort((a, b) => a.n - b.n)) {
        if (result.s === 'ok') applyPushResult(replica, ctx, result, body, unreadable);
      }
    }
    epochChange(replica, ctx, body.epoch);
    return undefined;
  }
  if (status === 409) {
    meta.serverEpoch ??= body.epoch;
    reidentify(replica, ctx);
    renewActor(ctx);
    return undefined;
  }
  if (status === 400 || status === 413) {
    if (status === 400) ctx.telemetry.push({ event: 'sync-push-malformed' });
    if (request.intents.length > 1) return { limit: Math.ceil(request.intents.length / 2) };
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === request.intents[0].n);
    if (entry) {
      meta.nextN = entry.n;
      for (const later of replica.entries()) if (later.state === 'sent' && later.n > entry.n) moveEntry(replica, ctx.ended, later, 'rewind');
      onRefused(replica, ctx, entry, { s: 'refused', code: status === 400 ? 'invalid' : 'too-large' }, body);
    }
    return undefined;
  }
  if (status !== 200) return undefined;

  let left = dieAfter;
  for (const result of [...body.results].sort((a, b) => a.n - b.n)) {
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
    if (!entry) continue;
    if (left <= 0) return undefined;
    left -= 1;
    applyPushResult(replica, ctx, result, body, unreadable);
  }
  meta.serverEpoch ??= body.epoch;
  meta.ackThrough = body.retry ? Math.min(body.lastN, body.retry.n - 1) : body.lastN;
  return undefined;
}


// One result's transaction. An `ok` whose receipt is unreadable (`unreadable` holds its n) still acknowledges its
// entry: the server holds the write. It records no receipt, so every projection ends at once and the pull
// brings the rows, its source's history proves nothing, and an inverse slot settles skipped `invalid`.
export function applyPushResult(replica, ctx, result, body, unreadable = new Set()) {
  const meta = replica.meta;
  const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
  if (!entry) return;
  meta.serverEpoch ??= body.epoch;
  if (unreadable.has(result.n)) {
    applyUnreadable(replica, ctx, entry, result, body);
    return;
  }
  const effects = entry.predictions && result.s === 'ok' ? receiptEffects(ctx.registry, entry, result) : undefined;
  if (result.s === 'refused') {
    onRefused(replica, ctx, entry, result, body);
    if (replica.entry(entry.localId) !== entry) retainOutcome(replica, entry.localId, { epoch: body.epoch, n: result.n, outcome: 'refused' });
    applyInverseResult(replica, entry, result, body.epoch);
    return;
  }
  moveEntry(replica, ctx.ended, entry, 'ok');
  entry.resultSeq = result.seq;
  entry.resultEpoch = body.epoch;
  replica.raiseAdmittedHigh((entry.intent.d ?? []).flatMap(stampsOf));
  if (result.write) applyWriteMap(replica, ctx, entry, result.write);
  if (effects) applyReceipt(replica, ctx, entry, effects, result.write ?? []);
  retainOutcome(replica, entry.localId, { epoch: body.epoch, n: result.n, outcome: 'ok', acceptedEffects: entry.acceptedEffects });
  resolveReferences(replica, entry, body.epoch);
  applyInverseResult(replica, entry, result, body.epoch);
  resolveIfCovered(replica, ctx, entry);
}

function applyUnreadable(replica, ctx, entry, result, body) {
  moveEntry(replica, ctx.ended, entry, 'ok');
  entry.resultSeq = result.seq;
  entry.resultEpoch = body.epoch;
  replica.raiseAdmittedHigh((entry.intent.d ?? []).flatMap(stampsOf));
  if (result.write) applyWriteMap(replica, ctx, entry, result.write);
  for (const projection of entry.predictions ?? []) projection.covered = true;
  retainOutcome(replica, entry.localId, { epoch: body.epoch, n: result.n, outcome: 'ok' });
  resolveIfCovered(replica, ctx, entry);
  applyInverseResult(replica, entry, { s: 'refused', code: 'invalid' }, body.epoch);
}

// The ACK transaction's receipt-application point, before any projection settles or the entry resolves.
export function applyReceipt(replica, ctx, entry, effects, write) {
  const previous = entry.acceptedEffects ?? [];
  entry.acceptedEffects = structuredClone(effects);
  for (const effect of effects) {
    let projection = entry.predictions.find((candidate) => candidate.scope === effect.scope);
    if (!projection) entry.predictions.push(projection = { scope: effect.scope, d: [] });
    if (effect.seq === null) projection.covered = true;
    else projection.resultSeq = effect.seq;
  }
  mergePredictions(entry);
  const accepted = structuredClone(effects);
  const rows = accepted.find((effect) => effect.scope === entry.scope).rows;
  for (const item of write) {
    let row = rows.find((row) => row.t === item.t && JSON.stringify(row.id) === JSON.stringify(item.id));
    if (!row) rows.push(row = { t: item.t, id: item.id, slots: [] });
    const slots = [
      ...(item.born === undefined ? [] : [{ slot: { kind: 'born' }, version: { kind: 'stamp', stamp: item.born } },
        { slot: { kind: 'life' }, version: { kind: 'stamp', stamp: item.born } }]),
      ...Object.entries(item.f ?? {}).map(([name, stamp]) => ({ slot: { kind: 'field', name }, version: { kind: 'stamp', stamp } })),
    ];
    for (const item of slots) if (!row.slots.some(({ slot }) => slot.kind === item.slot.kind && slot.name === item.slot.name)) row.slots.push(item);
  }
  applyAcceptedVersions(replica, ctx, entry, accepted, previous);
}

// §7.4 the sender's wait between pushes. A backoff draws a sleep in [0, min(ceiling, base · 2^k)) and
// raises k. A response with results resets k unless one is clock-skew, whose recovery is followed by a
// backoff. A server-requested wait (a 503's or a retry's retryAfterMs) is a floor no push passes. A
// kick wakes the sender, no earlier than the floor, and resets k, except during the backoff after a
// clock-skew recovery, which it neither cuts short nor resets. A leave (§7.3) pushes once whatever the
// backoff, but not before the floor, and leaves the wait as it was. `draw(bound)` answers the random
// sleep below `bound`.
export class SenderWait {
  constructor(limits = CONSTANTS) {
    this.limits = limits;
    this.k = 0;
    this.until = 0;
    this.floor = 0;
    this.afterSkew = false;
  }

  backoff(now, draw, { liveHint = false, afterSkew = false } = {}) {
    const ceiling = liveHint ? this.limits.BACKOFF_LIVE_CEILING_MS : this.limits.BACKOFF_CEILING_MS;
    this.until = Math.max(this.floor, now + draw(Math.min(ceiling, this.limits.BACKOFF_BASE_MS * 2 ** this.k)));
    this.k += 1;
    this.afterSkew = afterSkew;
  }

  // 503 {retryAfterMs}: a backoff that sleeps at least the server's wait.
  unavailable(now, retryAfterMs, draw, { liveHint = false } = {}) {
    this.floor = now + retryAfterMs;
    this.backoff(now, draw, { liveHint });
  }

  // retry {n, retryAfterMs}: wait that long, k as it was.
  retry(now, retryAfterMs) {
    this.floor = now + retryAfterMs;
    this.until = Math.max(this.until, this.floor);
  }

  results(codes, now, draw, { liveHint = false } = {}) {
    if (codes.includes('clock-skew')) return this.backoff(now, draw, { liveHint, afterSkew: true });
    if (codes.length) this.k = 0;
    return undefined;
  }

  kick(now) {
    if (this.afterSkew && now < this.until) return;
    this.k = 0;
    this.until = Math.max(now, this.floor);
    this.afterSkew = false;
  }

  due(now) {
    return now >= this.until;
  }

  leaveMayPush(now) {
    return now >= this.floor;
  }
}

// §10.4: every response carrying serverTime yields an offset sample, hello included. A 401, or a hello
// served as anyone but the replica's account, pauses sync (§9.1).
export function onHello(replica, ctx, response, timing) {
  if (response.body?.serverTime !== undefined) replica.takeOffsetSample(response.body.serverTime, timing, ctx.limits);
  if (replica.isUnauthenticated(response)) replica.meta.authPaused = true;
}
