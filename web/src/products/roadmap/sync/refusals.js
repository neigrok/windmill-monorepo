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
// A CAPACITY refusal is the third kind, and it is neither a verdict about the reader nor a doubt
// about the seat: the writer is allowed and the frame is well formed, but the tree cannot take it
// (the server caps a tree's size). What makes it dangerous is that it never resolves on its own —
// the outbox is derived from what the server has ACKED, so the same refused frame re-flushes
// forever while the person keeps editing a tree that will never save again.
//
// A code in NEITHER of the three sets is deliberately not guessed at — but silence is not the
// answer either: `strandsTheBank` is the shape that matters, and it reads the frameId rather than
// the code, so a refusal minted after this build (a malformed-frame code, say) still tells the
// truth instead of dying in a console.warn.

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

// Does this refusal leave edits banked with no way up? Any reject naming a frame does: that frame
// carried the writes, nothing acked them, and every later flush re-derives the same rejected
// delta. A refusal with no frameId (a progress mark) strands nothing.
export function strandsTheBank(frame) {
  return !!frame?.frameId;
}
