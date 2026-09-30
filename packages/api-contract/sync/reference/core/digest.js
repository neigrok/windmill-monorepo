// §6.12 the scope digest: the sum, mod 2^256, of sha256(jcs(row)) over a scope's alive rows, each row
// exactly as a page carries it. The wire and the stores carry it as 64 lowercase hex characters.

import { createHash } from 'node:crypto';
import { jcs } from './jcs.js';
import { isAlive } from './rows.js';

const MODULUS = 1n << 256n;

export const ZERO_DIGEST = '0'.repeat(64);

export function rowHash(row) {
  if (row === undefined || !isAlive(row)) return 0n;
  return BigInt(`0x${createHash('sha256').update(jcs(row), 'utf8').digest('hex')}`);
}

export function toHex(value) {
  return value.toString(16).padStart(64, '0');
}

export function fromHex(hex) {
  return BigInt(`0x${hex}`);
}

// One row change: `before` and `after` are the stored rows, undefined when absent.
export function replaceRow(digestHex, before, after) {
  const next = (fromHex(digestHex) - rowHash(before) + rowHash(after)) % MODULUS;
  return toHex((next + MODULUS) % MODULUS);
}

export function scopeDigest(rows) {
  let sum = 0n;
  for (const row of rows) sum = (sum + rowHash(row)) % MODULUS;
  return toHex(sum);
}
