// §7.4 the sender: numbering ready entries into a push, and the push response, one local transaction
// per result. Timing (tSend, tRecv) is the device clock around the request, for the offset (§10.4).

import { Offset } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { stampsOf } from '../core/rows.js';
import { intentDigest } from '../core/wire.js';
import { epochChange, reidentify } from './lifecycle.js';
import { applyWriteMap, onRefused } from './refusal.js';

// Numbers ready entries in commit order up to the batch limits, stopping after the first command
// entry, and never while a command entry is sent. `limit` (after a multi-intent 413) sends at most
// that many sent entries and numbers none beyond them. Answers the push request, or null.
export function nextPush(replica, ctx, { limit } = {}) {
  const limits = ctx.limits ?? CONSTANTS;
  const maxIntents = Math.min(limits.PUSH_MAX_INTENTS, limit ?? Infinity);
  const { meta } = replica;
  if (meta.state !== 'bound' || meta.authPaused) return null;
  const sent = () => replica.entries().filter((entry) => entry.state === 'sent').sort((a, b) => a.n - b.n);
  if (!sent().some((entry) => entry.intent.cmd !== undefined)) {
    let count = sent().length;
    let bytes = sent().reduce((sum, entry) => sum + Buffer.byteLength(jcs(entry.intent), 'utf8'), 0);
    for (const entry of replica.entries().filter((candidate) => candidate.state === 'ready')) {
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

function recordOffset(replica, body, timing) {
  const sample = Offset.sample({ serverTime: body.serverTime, ...timing });
  replica.meta.offsetSamples = Offset.record(replica.meta.offsetSamples, sample);
  replica.meta.serverOffsetMs = Offset.choose(replica.meta.offsetSamples);
}

// A push response, one local transaction per result. Answers {halve: true} after a 413 on several
// intents, so the caller's next nextPush passes half the count as `limit`; otherwise nothing.
export function onPushResponse(replica, ctx, request, response, timing) {
  const { meta } = replica;
  const { status, body } = response;
  if (body?.serverTime !== undefined) recordOffset(replica, body, timing);
  if (status === 401) {
    meta.authPaused = true;
    return undefined;
  }
  if (status === 409) {
    reidentify(replica, ctx);
    return undefined;
  }
  if ((status === 400 || status === 413) && request.intents.length === 1) {
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === request.intents[0].n);
    if (entry) {
      meta.nextN = entry.n;
      onRefused(replica, ctx, entry, { s: 'refused', code: status === 400 ? 'invalid' : 'too-large' }, body);
    }
    return undefined;
  }
  if (status === 413) return { halve: true };
  if (status !== 200) return undefined;

  meta.serverEpoch ??= body.epoch;
  for (const result of [...body.results].sort((a, b) => a.n - b.n)) {
    const entry = replica.entries().find((candidate) => candidate.state === 'sent' && candidate.n === result.n);
    if (!entry) continue;
    if (result.s === 'refused') {
      onRefused(replica, ctx, entry, result, body);
      continue;
    }
    if (entry.orphanOf !== undefined) {
      moveEntry(replica, ctx.ended, entry, 'orphan-ok');
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

// §10.4: every response carrying serverTime yields an offset sample, hello included.
export function onHello(replica, response, timing) {
  if (response.body?.serverTime !== undefined) recordOffset(replica, response.body, timing);
}
