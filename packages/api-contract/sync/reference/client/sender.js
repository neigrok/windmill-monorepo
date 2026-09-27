// §7.4 the sender: numbering ready entries into a push, and the push response, one local transaction
// per result. Timing {send, recv} is the device clocks' readings around the request, for the offset
// sample (§10.4).

import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { stampsOf } from '../core/rows.js';
import { intentDigest } from '../core/wire.js';
import { Dependents, deltasOf, scopedKey } from './dependents.js';
import { epochChange, reidentify, renewActor } from './lifecycle.js';
import { applyWriteMap, onRefused } from './refusal.js';

// §7.4 held back: the ready entries that depend (§7.7 step 3) on a held or held-back entry or on an
// orphan awaiting its result (sent, or returned to ready), or touch a record an earlier held-back entry
// touches, by a delta, a guard or a prediction.
function heldBack(replica, registry) {
  const sources = new Dependents(registry);
  const touched = new Set();
  const back = new Set();
  for (const entry of replica.entries()) {
    if (entry.state === 'ready') {
      const records = [...deltasOf(entry), ...(entry.intent.guard ?? [])].map((target) => scopedKey(entry.scope, target.t, target.id));
      if (sources.of(entry).any || records.some((record) => touched.has(record))) {
        back.add(entry);
        for (const record of records) touched.add(record);
      }
    }
    const awaiting = entry.orphanOf !== undefined && (entry.state === 'sent' || entry.state === 'ready');
    if (entry.state === 'held' || back.has(entry) || awaiting) sources.absorb(entry.scope, deltasOf(entry), entry.stamp);
  }
  return back;
}

// Numbers ready entries in commit order up to the batch limits, passing over held-back entries,
// stopping after the first command entry or at a held-back one, and never while a command entry is
// sent. `limit` (after a several-intent 400 or 413) sends at most that many sent entries and numbers
// none beyond them. Answers the push request, or null.
export function nextPush(replica, ctx, { limit } = {}) {
  const limits = ctx.limits ?? CONSTANTS;
  const maxIntents = Math.min(limits.PUSH_MAX_INTENTS, limit ?? Infinity);
  const { meta } = replica;
  if (meta.state !== 'bound' || meta.authPaused) return null;
  const sent = () => replica.entries().filter((entry) => entry.state === 'sent').sort((a, b) => a.n - b.n);
  if (!sent().some((entry) => entry.intent.cmd !== undefined)) {
    let count = sent().length;
    let bytes = sent().reduce((sum, entry) => sum + Buffer.byteLength(jcs(entry.intent), 'utf8'), 0);
    const back = heldBack(replica, ctx.registry);
    for (const entry of replica.entries().filter((candidate) => candidate.state === 'ready')) {
      if (back.has(entry)) {
        if (entry.intent.cmd !== undefined) break;
        continue;
      }
      const intent = { ...entry.intent, n: meta.nextN };
      const size = Buffer.byteLength(jcs(intent), 'utf8');
      if (count >= maxIntents || (count > 0 && bytes + size > limits.PUSH_MAX_BYTES)) break;
      entry.intent = intent;
      entry.n = meta.nextN;
      entry.digest = intentDigest(intent);
      entry.numbered = true;
      moveEntry(replica, ctx.ended, entry, 'number');
      meta.nextN += 1;
      count += 1;
      bytes += size;
      if (intent.cmd !== undefined) break;
    }
  }
  const batch = sent().slice(0, maxIntents);
  if (batch.length === 0) return null;
  return { replica: meta.replica, ackThrough: meta.ackThrough, intents: batch.map((entry) => entry.intent) };
}

// A push response, one local transaction per result. After a 400 or 413 on several intents it answers
// {limit}, ⌈count/2⌉, which the caller's next nextPush passes to resend the first half by n; otherwise
// nothing. Every 400 emits sync-push-malformed. After a 409 or an epoch change the instance takes a new
// actor (§7.11).
export function onPushResponse(replica, ctx, request, response, timing) {
  const { meta } = replica;
  const { status, body } = response;
  if (body?.serverTime !== undefined) replica.takeOffsetSample(body.serverTime, timing, ctx.limits);
  if (status === 401) {
    meta.authPaused = true;
    return undefined;
  }
  if (status === 409) {
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

  meta.serverEpoch ??= body.epoch;
  for (const result of [...body.results].sort((a, b) => a.n - b.n)) {
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
    if (!entry) continue;
    if (result.s === 'refused') {
      onRefused(replica, ctx, entry, result, body);
      continue;
    }
    moveEntry(replica, ctx.ended, entry, 'ok');
    entry.resultSeq = result.seq;
    entry.resultEpoch = body.epoch;
    replica.raiseAdmittedHigh((entry.intent.d ?? []).flatMap(stampsOf));
    if (result.write) applyWriteMap(replica, ctx, entry, result.write);
  }
  meta.ackThrough = body.lastN;
  if (body.epoch !== meta.serverEpoch) epochChange(replica, ctx, body.epoch);
  return undefined;
}

// §7.4 the sender's wait between pushes. A backoff draws a sleep in [0, min(ceiling, base · 2^k)) and
// raises k. A response with results resets k unless one is clock-skew, whose recovery is followed by a
// backoff. A kick wakes the sender and resets k, except during the backoff after a clock-skew recovery,
// which it neither cuts short nor resets. `draw(bound)` answers the random sleep below `bound`.
export class SenderWait {
  constructor(limits = CONSTANTS) {
    this.limits = limits;
    this.k = 0;
    this.until = 0;
    this.afterSkew = false;
  }

  backoff(now, draw, { liveHint = false, afterSkew = false } = {}) {
    const ceiling = liveHint ? this.limits.BACKOFF_LIVE_CEILING_MS : this.limits.BACKOFF_CEILING_MS;
    this.until = now + draw(Math.min(ceiling, this.limits.BACKOFF_BASE_MS * 2 ** this.k));
    this.k += 1;
    this.afterSkew = afterSkew;
  }

  results(codes, now, draw, { liveHint = false } = {}) {
    if (codes.includes('clock-skew')) return this.backoff(now, draw, { liveHint, afterSkew: true });
    if (codes.length) this.k = 0;
    return undefined;
  }

  kick(now) {
    if (this.afterSkew && now < this.until) return;
    this.k = 0;
    this.until = now;
    this.afterSkew = false;
  }

  due(now) {
    return now >= this.until;
  }
}

// §10.4: every response carrying serverTime yields an offset sample, hello included.
export function onHello(replica, ctx, response, timing) {
  if (response.body?.serverTime !== undefined) replica.takeOffsetSample(response.body.serverTime, timing, ctx.limits);
}
