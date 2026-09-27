// §9 encodings both roles compute: the §6.2 intent digest, a request body's size (§9.1), the §9.4
// cursor as unpadded base64url of jcs({e, m, s, k?, a?}), and the string rule both check an intent by
// (§6.1 step 2, §7.1 step 7).

import { createHash } from 'node:crypto';
import { jcs } from './jcs.js';

export function intentDigest(intent) {
  return createHash('sha256').update(jcs(intent), 'utf8').digest('hex');
}

// A request body's bytes as the server measures them: a client sends the request's jcs (§7.4).
export function bodyBytes(request) {
  return Buffer.byteLength(jcs(request), 'utf8');
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
    return Buffer.from(jcs(cursor), 'utf8').toString('base64url');
  },

  decode(text) {
    if (typeof text !== 'string') return null;
    let cursor;
    try {
      cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    return isCursor(cursor) && Cursor.encode(cursor) === text ? cursor : null;
  },
};
