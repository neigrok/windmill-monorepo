// §6.3 server-origin calls, deduplicated per (account, requestId) by sha256(jcs({tool, args})); each
// admit k stores part k in its own transaction, and `crashAfter: k` stops after part k. Live events as push's.

import { createHash } from 'node:crypto';
import { CONSTANTS } from '../core/constants.js';
import { jcs } from '../core/jcs.js';
import { admit } from './admit.js';
import { liveEventsOf } from './pull.js';

function callDigest(tool, args) {
  return createHash('sha256').update(jcs({ tool, args }), 'utf8').digest('hex');
}

export function serverCall({ state, registry, product, account, requestId, tool, args, intents, serverNow, crashAfter, limits = CONSTANTS }) {
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
    for (const intent of intents) {
      result = admitOne(intent);
      if (result.s === 'refused') break;
    }
    return done(work, result);
  }

  const digest = callDigest(tool, args);
  work.requests[account] ??= {};
  const stored = work.requests[account][requestId];
  if (stored && stored.digest !== digest) return done(state, { s: 'refused', code: 'request-conflict' });
  if (stored?.state === 'done') return done(state, stored.result);
  if (stored && serverNow - stored.startedAt < limits.REQUEST_LEASE_MS) return done(state, { s: 'refused', code: 'request-running' });
  const row = stored ?? { requestId, digest, state: 'running', startedAt: serverNow, parts: [] };
  work.requests[account][requestId] = row;
  row.startedAt = serverNow;

  let result;
  for (const [index, intent] of intents.entries()) {
    const k = index + 1;
    const part = row.parts.find((entry) => entry.k === k);
    if (part) {
      result = part.result;
    } else {
      result = admitOne({ ...intent, gestureId: requestId });
      work.requests[account][requestId] = row;
      row.parts.push({ k, result });
      row.startedAt = serverNow;
      if (crashAfter === k) return done(work, undefined);
    }
    if (result.s === 'refused') break;
  }
  row.state = 'done';
  row.result = result;
  return done(work, result);
}
