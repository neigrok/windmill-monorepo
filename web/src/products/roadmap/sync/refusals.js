// A reject frame is classified by its `code`, never by its prose. An ownership refusal is a
// verdict — the editor demotes to read-only. A session refusal may clear on re-checking the
// session. A capacity refusal never resolves on its own: the outbox is derived from what the
// server acked, so the same frame re-flushes forever. A code in none of the three sets is not
// guessed at; `strandsTheBank` reads the frameId instead.

const OWNERSHIP_CODES = new Set(['not-yours', 'nobodys-tree']);
const SESSION_CODES = new Set(['sign-in-required']);
const CAPACITY_CODES = new Set(['tree-too-large']);

export function isOwnershipRefusal(frame) {
  return OWNERSHIP_CODES.has(frame?.code);
}

export function isSessionRefusal(frame) {
  return SESSION_CODES.has(frame?.code);
}

export function isCapacityRefusal(frame) {
  return CAPACITY_CODES.has(frame?.code);
}

// Any reject naming a frame leaves edits banked with no way up; a refusal with no frameId
// strands nothing.
export function strandsTheBank(frame) {
  return !!frame?.frameId;
}
