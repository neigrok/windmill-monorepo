// §9 encodings both roles compute: the §6.2 intent digest, and the §9.4 cursor as unpadded base64url
// of jcs({e, m, s, k?, a?}).

import { createHash } from 'node:crypto';
import { jcs } from './jcs.js';

export function intentDigest(intent) {
  return createHash('sha256').update(jcs(intent), 'utf8').digest('hex');
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
  if (!Number.isInteger(cursor.s) || cursor.s < 0) return false;
  if (cursor.k !== undefined && !(Array.isArray(cursor.k) && cursor.k.length === 2 && typeof cursor.k[0] === 'string' && isId(cursor.k[1]))) return false;
  if (cursor.m === 'live') return cursor.a === undefined;
  return Number.isInteger(cursor.a) && cursor.a >= cursor.s;
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
