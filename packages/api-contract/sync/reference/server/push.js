// §6.2 push and §6.6 faults: `budget` counts admissions before `retry` (PUSH_WORK_MS as a count), and
// `faultOf(replica, n)` injects a transient or a deterministic fault.

import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { intentDigest } from '../core/wire.js';
import { admit } from './admit.js';
import { liveEventsOf } from './pull.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PUSH_KEYS = ['ackThrough', 'intents', 'replica'];
const REPLICA_ID = /^rp_[0-9a-f]{32}$/;

// §9.3: exactly {replica, ackThrough, intents}, with a replica id of D-3's pattern.
function isWellFormed(request) {
  return isObject(request)
    && Object.keys(request).sort().join() === PUSH_KEYS.join()
    && typeof request.replica === 'string' && REPLICA_ID.test(request.replica)
    && Number.isInteger(request.ackThrough) && request.ackThrough >= 0
    && Array.isArray(request.intents)
    && request.intents.every((intent) => isObject(intent) && Number.isInteger(intent.n) && intent.n >= 1);
}

// Answers {state, response, live, frames}: `live` is every admission's change frame and death events in
// order (§6.8), `frames` its change frames alone.
export function push({ state, registry, product, account, request, serverNow, budget = Infinity, faultOf = () => null, limits = CONSTANTS }) {
  const head = { serverTime: serverNow, epoch: state.epoch };
  const answer = (status, error) => ({ state, response: { status, body: { ...head, error } }, live: [], frames: [] });
  if (account === null || account === undefined) return answer(401, 'unauthenticated');
  if (!isWellFormed(request)) return answer(400, 'malformed');
  const tooMany = request.intents.length > limits.PUSH_MAX_INTENTS;
  if (tooMany || Buffer.byteLength(jcs(request), 'utf8') > limits.PUSH_MAX_BYTES) return answer(413, 'request-too-large');
  const { replica } = request;
  const bound = state.replicas[replica];
  if (bound && bound.account !== account) return answer(409, 'replica-foreign');

  let work = state.clone();
  work.replicas[replica] ??= { account, lastN: 0 };
  const results = [];
  const live = [];
  const conflict = (error) => {
    if (!bound && work.replicas[replica].lastN === 0) delete work.replicas[replica];
    return { state: work, response: { status: 409, body: { ...head, error } }, live, frames: live.filter((event) => event.frame) };
  };
  let retry;
  let admitted = 0;
  for (const intent of [...request.intents].sort((a, b) => a.n - b.n)) {
    const { n } = intent;
    const digest = intentDigest(intent);
    const binding = work.replicas[replica];
    if (n <= binding.lastN) {
      const stored = work.resultOf(replica, n);
      if (!stored || stored.result === null || stored.digest !== digest) return conflict('replica-forked');
      results.push({ n, ...stored.result });
      continue;
    }
    if (n > binding.lastN + 1) return conflict('gap');
    if (admitted >= budget) {
      retry = { n, retryAfterMs: 0 };
      break;
    }
    admitted += 1;
    const fault = faultOf(replica, n);
    if (fault === 'transient') {
      retry = { n, retryAfterMs: 1000 };
      break;
    }
    if (fault === 'fault') {
      const previous = work.resultOf(replica, n);
      const faults = (previous?.digest === digest ? previous.faults : 0) + 1;
      if (faults < limits.K_POISON) {
        work.putResult(replica, { n, digest, result: null, faults });
        retry = { n, retryAfterMs: 0 };
        break;
      }
      const poisoned = { s: 'refused', code: 'internal' };
      work.putResult(replica, { n, digest, result: poisoned, faults });
      binding.lastN = n;
      results.push({ n, ...poisoned });
      continue;
    }
    const outcome = admit({ state: work, registry, product, origin: { kind: 'replica', account, replica, n }, intent, serverNow, limits });
    work = outcome.state;
    work.putResult(replica, { n, digest, result: outcome.result, faults: 0 });
    work.replicas[replica].lastN = n;
    results.push({ n, ...outcome.result });
    live.push(...liveEventsOf(work, outcome, limits));
  }
  work.pruneResults(replica, Math.min(request.ackThrough, work.replicas[replica].lastN));
  const body = { ...head, lastN: work.replicas[replica].lastN, results };
  if (retry) body.retry = retry;
  return { state: work, response: { status: 200, body }, live, frames: live.filter((event) => event.frame) };
}
