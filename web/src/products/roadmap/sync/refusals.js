// What the editor does about a reject frame is decided by the frame's `code` — the stable word the
// server mints beside its prose (backend/products/roadmap/adapters/ws/Collab.cpp; the ownership
// pair lives in platform/domain/Access.h) — never by the sentence, which is for humans and free to
// change.
//
// The split is by what the reader can do about it. An OWNERSHIP refusal is a verdict: nothing that
// happens in this tab changes it, so the editor demotes to read-only and says so. Two codes say it —
// someone else owns this tree, and nobody does (the seeded demo tree and any legacy orphan, which
// canWrite refuses because an unowned tree is nobody's to write). A SESSION refusal is only a
// suspicion, which re-checking the session may clear.
//
// A code in neither set is deliberately neither: the caller warns rather than guessing at a verdict.

const OWNERSHIP_CODES = new Set(['not-yours', 'nobodys-tree']);
const SESSION_CODES = new Set(['sign-in-required']);

export function isOwnershipRefusal(frame) {
  return OWNERSHIP_CODES.has(frame?.code);
}

export function isSessionRefusal(frame) {
  return SESSION_CODES.has(frame?.code);
}
