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

export const COACHED_NODE_ID = 'rigging';        // "Rig the boat yourself" — the single ready step
export const COACHED_CHILDREN = ['jibing', 'tacking']; // the two paths its completion opens

export const COACH_DONE_KEY = 'wm-coach-done';   // once ever, per human
export const FORKED_FROM_DEMO_KEY = 'windmill:forked-from-demo'; // one-shot note the fork leaves for the re-plant

export const DEMO_COPY = {
  plaqueByline: 'Windmill demo',
  coachSentence: 'This step is ready — mark it done.',
  coachButton: 'Mark it done',
  unlockToast: 'Step unlocked: Rig the boat yourself · 2 steps opened',
  forkToast: 'Forked — 17 steps planted',
};

export function coachEligible({ coachDone, signedIn, ownsTrees }) {
  if (coachDone) return false;
  if (signedIn && ownsTrees) return false;
  return true;
}
