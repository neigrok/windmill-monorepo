import { utf8, compareBytes, encode64, decode64 } from './encoding.js';

// §9 encodings both roles compute: the §6.2 intent digest, a request body's size (§9.1), the account id
// form (§9.1), the widest body of an intent pushed alone (§7.1 step 8), the §9.4 cursor as unpadded base64url of
// jcs({e, m, s, k?, a?}), and the string rule both check an intent by (§6.1 step 2, §7.1 step 7).

import { hashText } from './encoding.js';
import { CONSTANTS } from './constants.js';
import { jcs } from './jcs.js';

export function intentDigest(intent) {
  return hashText(jcs(intent));
}

// A request body's bytes as the server measures them: a client sends the request's jcs (§7.4).
export function bodyBytes(request) {
  return utf8(jcs(request)).length;
}

// §9.1: an account id is at most ACCOUNT_ID_BYTES bytes of UTF-8, holding no character jcs escapes.
export function isAccountId(id) {
  return typeof id === 'string' && utf8(id).length <= CONSTANTS.ACCOUNT_ID_BYTES && jcs(id) === `"${id}"`;
}

// §7.1 step 8: the body of `intent` pushed alone by a replica at its widest: `n` and `ackThrough` at
// 2^53 − 1, and the replica's account, or, for an anon replica (no account yet), an account of
// ACCOUNT_ID_BYTES. An entry that fits it fits any request alone.
export function widestAloneBytes({ replica, account }, intent) {
  const widest = Number.MAX_SAFE_INTEGER;
  return bodyBytes({ replica, account: account ?? 'a'.repeat(CONSTANTS.ACCOUNT_ID_BYTES), ackThrough: widest, intents: [{ ...intent, n: widest }] });
}

// Any string of the value, a key or a value at any depth, holding U+0000.
export function holdsNul(value) {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(holdsNul);
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([key, inner]) => key.includes('\u0000') || holdsNul(inner));
  return false;
}

const CURSOR_KEYS = new Set(['e', 'm', 's', 'k', 'a']);

function isId(id) {
  return typeof id === 'string' || (Array.isArray(id) && id.length > 0 && id.every((part) => typeof part === 'string'));
}

// e a string; m boot or live; s a seq; k absent or [type, id]; a present iff booting, at least s.
function isCursor(cursor) {
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
  if (Object.keys(cursor).some((key) => !CURSOR_KEYS.has(key))) return false;
  if (typeof cursor.e !== 'string' || !['boot', 'live'].includes(cursor.m)) return false;
  if (!Number.isSafeInteger(cursor.s) || cursor.s < 0) return false;
  if (cursor.k !== undefined && !(Array.isArray(cursor.k) && cursor.k.length === 2 && typeof cursor.k[0] === 'string' && isId(cursor.k[1]))) return false;
  if (cursor.m === 'live') return cursor.a === undefined;
  return Number.isSafeInteger(cursor.a) && cursor.a >= cursor.s;
}

export const Cursor = {
  encode(cursor) {
    return encode64(jcs(cursor));
  },

  decode(text) {
    if (typeof text !== 'string') return null;
    let cursor;
    try {
      cursor = JSON.parse(decode64(text));
    } catch {
      return null;
    }
    return isCursor(cursor) && Cursor.encode(cursor) === text ? cursor : null;
  },
};
