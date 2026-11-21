export const DEMO_TREE_ID = 't_9e407a96b5330ebe';

// This set leaves "Rig the boat yourself" the single ready step.
export const DEMO_STAGED_COMPLETED = [
  'dream',           // Dream of sailing
  'boat-parts',      // Parts of the boat
  'wind-basics',     // How wind moves a boat
  'first-aboard',    // First time on board
  'points-of-sail',  // Points of sail
  'forecast',        // Read a forecast
];

// The demo's marks as every reading of it shows them, whoever owns the sample and whatever they marked: the staged set,
// undated, none of them the server's.
export const stagedMarks = () => ({ completed: new Set(DEMO_STAGED_COMPLETED), completedAt: {}, server: false });

export const COACHED_NODE_ID = 'rigging';        // "Rig the boat yourself" — the single ready step
export const COACHED_CHILDREN = ['jibing', 'tacking']; // the two paths its completion opens

export const COACH_DONE_KEY = 'wm-coach-done';   // once ever, per human

export function coachEligible({ coachDone, signedIn, ownsTrees }) {
  if (coachDone) return false;
  if (signedIn && ownsTrees) return false;
  return true;
}
