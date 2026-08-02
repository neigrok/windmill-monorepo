// The server's write refusals, matched by their exact sentences because a reject frame carries
// prose and no code. They are one truth stated in two languages — C++ mints them in
// adapters/ws/Collab.cpp, this file decides what the editor does about them — so test/…/sync/
// refusals.test.js reads the C++ constants and asserts the two halves still agree.
//
// The split is by what the reader can do about it. An OWNERSHIP refusal is a verdict: nothing that
// happens in this tab changes it, so the editor demotes to read-only and says so. Two sentences say
// it — someone else owns this tree, and nobody does (the seeded demo tree and any legacy orphan,
// which canWrite refuses because an unowned tree is nobody's to write). A SESSION refusal is only a
// suspicion, which re-checking the session may clear.
//
// A sentence in neither list is deliberately neither: the caller warns rather than guessing at a
// verdict. That is also the trap — a new refusal on the server must be taught to this file in the
// same breath, or the chrome goes quiet on a write the user just lost. A reject frame carrying a
// stable code would retire the whole arrangement; until it does, the test is the guard.

const OWNERSHIP_REFUSALS = [
  'this tree belongs to another account',
  'no account owns this tree, so it cannot be edited — you can still read it, or fork it into a roadmap of your own',
];

const SESSION_REFUSALS = ['sign in to edit', 'sign in to track progress'];

export function isOwnershipRefusal(reason) {
  return OWNERSHIP_REFUSALS.includes(reason);
}

export function isSessionRefusal(reason) {
  return SESSION_REFUSALS.includes(reason);
}
