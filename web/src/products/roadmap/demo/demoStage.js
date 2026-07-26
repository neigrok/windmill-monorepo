// The playable demo (F4): the hosted "Learn to sail" tree a stranger meets first,
// made complete-only + session-local + coached. This module is the demo's single
// source of truth — which tree, which six steps are staged done, which step the
// coach points at, and the once-ever eligibility rule — kept pure so the overlay
// and the coach both read the same constants and a node test can assert them.

export const DEMO_TREE_ID = 't_9e407a96b5330ebe';

// The staged save (spec §01): six of the seventeen sail steps land already done, so
// exactly one move matters. This set leaves "Rig the boat yourself" the single ready
// step whose completion wakes BOTH its children — the unique "one move opens two paths".
// (Verified against the live DAG: these six also leave "Rules of the water" ready off
// to the side, which wakes no children, so the coach pulses only the rigging node.)
export const DEMO_STAGED_COMPLETED = [
  'dream',           // Dream of sailing
  'boat-parts',      // Parts of the boat
  'wind-basics',     // How wind moves a boat
  'first-aboard',    // First time on board
  'points-of-sail',  // Points of sail
  'forecast',        // Read a forecast
];

export const COACHED_NODE_ID = 'rigging';        // "Rig the boat yourself" — the single ready step
export const COACHED_CHILDREN = ['jibing', 'tacking']; // the two paths its completion opens

export const COACH_DONE_KEY = 'wm-coach-done';   // once ever, per human (localStorage + tree-owner ineligibility)
export const FORKED_FROM_DEMO_KEY = 'windmill:forked-from-demo'; // one-shot note the fork leaves for the re-plant

// Copy — canon, verbatim (spec §07). The unlock toast uses the real node label
// ("Rig the boat yourself") rather than the canon specimen ("Rig the mast") so it
// stays honest against the live tree.
export const DEMO_COPY = {
  plaqueByline: 'Windmill demo',
  coachSentence: 'This step is ready — mark it done.',
  coachButton: 'Mark it done',
  unlockToast: 'Step unlocked: Rig the boat yourself · 2 steps opened',
  forkToast: 'Forked — 17 steps planted',
};

// The coach is for strangers only (spec §03): it never mounts once it has run (the
// once-ever note), and never for a signed-in account that already owns trees. A
// signed-in visitor with no trees of their own is still a stranger — eligible.
export function coachEligible({ coachDone, signedIn, ownsTrees }) {
  if (coachDone) return false;
  if (signedIn && ownsTrees) return false;
  return true;
}
