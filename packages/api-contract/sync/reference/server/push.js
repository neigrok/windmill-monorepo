// §6.2 push and §6.6 faults: `budget` counts admissions before `retry` (PUSH_WORK_MS as a count), and
// `faultOf(replica, n)` injects a transient or a deterministic fault.

import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { bodyBytes, intentDigest } from '../core/wire.js';
import { credentialFails } from './access.js';
import { admit } from './admit.js';
import { liveEventsOf } from './pull.js';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const PUSH_KEYS = ['account', 'ackThrough', 'intents', 'replica'];
const REPLICA_ID = /^rp_[0-9a-f]{32}$/;

// §9.3: exactly {replica, account, ackThrough, intents}, with a replica id of D-3's pattern, a string
// account and safe integers (§9.1).
function isWellFormed(request) {
  return isObject(request)
    && Object.keys(request).sort().join() === PUSH_KEYS.join()
    && typeof request.replica === 'string' && REPLICA_ID.test(request.replica)
    && typeof request.account === 'string'
    && Number.isSafeInteger(request.ackThrough) && request.ackThrough >= 0
    && Array.isArray(request.intents)
    && request.intents.every((intent) => isObject(intent) && Number.isSafeInteger(intent.n) && intent.n >= 1);
}

// Answers {state, response, live, frames}: `live` is every admission's change frame and death events in
// order (§6.8), `frames` its change frames alone. The envelope is checked in §9.1's order; the body as
// received is `jcs(request)`, measured before its shape. `account` is the account the request is served
// as, as pull takes it, and every answer carries it as `as`; a 401 carries null.
export function push({ state, registry, product, account = null, credential, request, serverNow, budget = Infinity, faultOf = () => null, limits = CONSTANTS }) {
  const head = { serverTime: serverNow, epoch: state.epoch, as: account };
  const answer = (status, error, as = account) => ({ state, response: { status, body: { ...head, as, error } }, live: [], frames: [] });
  if (credentialFails(account, credential) || account === null) return answer(401, 'unauthenticated', null);
  if (bodyBytes(request) > limits.PUSH_MAX_BYTES) return answer(413, 'request-too-large');
  if (!isWellFormed(request)) return answer(400, 'malformed');
  if (request.intents.length > limits.PUSH_MAX_INTENTS) return answer(413, 'request-too-large');
  const { replica } = request;
  if (request.account !== account) return answer(409, 'account-mismatch');
  const bound = state.replicas[replica];
  if (bound && bound.account !== request.account) return answer(409, 'replica-foreign');

  let work = state.clone();
  work.replicas[replica] ??= { account: request.account, lastN: 0 };
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
