// §6.3 server-origin calls, deduplicated per (account, requestId) by sha256(jcs({tool, args})); a
// requestId is a non-empty string without `#` or U+0000, else the call is invalid. Each admit k stores
// part k in its own transaction, and a run's first admit also holds the lookup and any lease takeover;
// a stored part is replayed without writing, and a refused one, stored or new, ends the call. After
// the last part the call writes its result, done, in a transaction of its own. `crashAfter: k` stops
// right after part k, before that write even when k is the last; `transientAt: k` fails admit k
// transiently, rolled back; `faultAt: k` faults admit k, which ends the call `refused internal`, stored
// as done. Live events as push's.

import { createHash } from 'node:crypto';
import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { admit } from './admit.js';
import { liveEventsOf } from './pull.js';

const INTERNAL = Object.freeze({ s: 'refused', code: 'internal' });

function callDigest(tool, args) {
  return createHash('sha256').update(jcs({ tool, args }), 'utf8').digest('hex');
}

export function serverCall({ state, registry, product, account, requestId, tool, args, intents, serverNow, crashAfter, transientAt, faultAt, limits = CONSTANTS }) {
  const origin = { kind: 'server', account };
  let work = state.clone();
  const live = [];
  const done = (next, result) => ({ state: next, result, live: next === state ? [] : live, frames: next === state ? [] : live.filter((event) => event.frame) });
  const admitOne = (intent) => {
    const outcome = admit({ state: work, registry, product, origin, intent, serverNow, limits });
    work = outcome.state;
    live.push(...liveEventsOf(work, outcome, limits));
    return outcome.result;
  };

  if (requestId === undefined) {
    let result;
    for (const [index, intent] of intents.entries()) {
      if (faultAt === index + 1) return done(work, INTERNAL);
      result = admitOne(intent);
      if (result.s === 'refused') break;
    }
    return done(work, result);
  }

  if (typeof requestId !== 'string' || requestId === '' || /[#\u0000]/.test(requestId)) return done(state, { s: 'refused', code: 'invalid' });
  const digest = callDigest(tool, args);
  work.requests[account] ??= {};
  const stored = work.requests[account][requestId];
  if (stored && stored.digest !== digest) return done(state, { s: 'refused', code: 'request-conflict' });
  if (stored?.state === 'done') return done(state, stored.result);
  if (stored && serverNow - stored.startedAt < limits.REQUEST_LEASE_MS) return done(state, { s: 'refused', code: 'request-running' });
  const row = stored ?? { requestId, digest, state: 'running', startedAt: serverNow, parts: [] };
  work.requests[account][requestId] = row;
  row.startedAt = serverNow;

  const first = row.parts.length + 1;
  let result;
  for (const [index, intent] of intents.entries()) {
    const k = index + 1;
    const part = row.parts.find((entry) => entry.k === k);
    if (part) {
      result = part.result;
    } else {
      if (transientAt === k) return done(k === first ? state : work, null);
      if (faultAt === k) {
        work.requests[account][requestId] = row;
        row.parts.push({ k, result: INTERNAL });
        Object.assign(row, { state: 'done', result: INTERNAL, startedAt: serverNow });
        return done(work, INTERNAL);
      }
      result = admitOne({ ...intent, gestureId: requestId });
      work.requests[account][requestId] = row;
      row.parts.push({ k, result });
      row.startedAt = serverNow;
      if (crashAfter === k) return done(work, null);
    }
    if (result.s === 'refused') break;
  }
  row.state = 'done';
  row.result = result;
  return done(work, result);
}
