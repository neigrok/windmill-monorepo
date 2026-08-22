// Progress is three states — not started, in progress, complete — plus the two stamps that say
// when each transition happened. advanceProgress is the whole machine, pure: it takes the progress
// as it stands, the steps moving and where they are moving to, and returns the NEXT progress.
// Nothing here reads a store, a socket or the clock; `now` is handed in so a caller stamps a whole
// bulk mark with one moment.
//
// WHEN each transition happened is deliberately not answered here any more. It used to be — by two
// functions that ranked a server map against a local one — and both are gone with the second copy
// they existed to reconcile: a mark is one stamped register in the private lane now, and it
// carries its own instant (sync/progressLattice.js).
//
// milestoneAnnouncement is the other half of a completion: which of the milestones that just landed
// is the one worth showing, and the sentence it earns. Pure for the same reason detectMilestones is
// — the conduct around it (owner-only, the once-ever ledger) needs a device, and this does not.

export function advanceProgress(progress, ids, target, now) {
  const completed = new Set(progress.completed);
  const inProgress = new Set(progress.inProgress);
  const startedAt = { ...progress.startedAt };
  const completedAt = { ...progress.completedAt };

  for (const id of ids) {
    if (target === 'complete') {
      completed.add(id);
      inProgress.delete(id);
      completedAt[id] = now;
      continue;
    }
    if (target === 'notstarted') {
      completed.delete(id);
      inProgress.delete(id);
      delete startedAt[id];
      delete completedAt[id];
      continue;
    }
    inProgress.add(id);
    completed.delete(id);
    if (!startedAt[id]) startedAt[id] = now;
    delete completedAt[id];
  }

  return { completed, inProgress, startedAt, completedAt };
}

// The crown wins whenever it landed — completing the last step also completes its branch, and the
// whole tree is the bigger picture. Otherwise the biggest limb is the better picture. A diamond
// step can finish two limbs at once; only one is announced, and the caller marks them all offered.
export function milestoneAnnouncement(fresh) {
  if (!fresh || fresh.length === 0) return null;
  const best = fresh.find((milestone) => milestone.kind === 'crown')
    ?? fresh.reduce((a, b) => (b.done > a.done ? b : a));
  if (best.kind === 'crown') {
    return { summary: `Tree complete — ${best.total}/${best.total} steps.`, label: 'Share it' };
  }
  return { summary: `Branch complete: ${best.label} · ${best.done}/${best.total} steps`, label: 'Share the moment' };
}
