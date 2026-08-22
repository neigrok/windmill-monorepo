// Progress is three states — not started, in progress, complete — plus the two stamps that say
// when each transition happened. advanceProgress is the whole machine, pure: it takes the progress
// as it stands, the steps moving and where they are moving to, and returns the NEXT progress.
// Nothing here reads a store, a socket or the clock; `now` is handed in so a caller stamps a whole
// bulk mark with one moment.
//
// reconcileOverlay is what a tree opening does with the two accounts of progress it is handed, and
// stampsFor answers the third question a loaded tree asks — WHEN each of those transitions
// happened — and it is the one place that ranks the two clocks that can answer. A browser stamps
// only the marks it made itself, so a step finished on a phone or by an agent has no local stamp
// at all; the server holds one for every mark that ever reached it, on its own clock. So the
// server's instant wins wherever it exists, the device's fills the gaps (a mark still pending its
// push, a local-born tree the server has never seen), and a step neither can date stays undated
// rather than guessed at.
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

export function stampsFor(ids, serverMarkedAt = {}, localStamps = {}) {
  const stamps = {};
  for (const id of ids) {
    const at = serverMarkedAt[id] ?? localStamps[id];
    if (at != null) stamps[id] = at;
  }
  return stamps;
}

// A tree opens holding two accounts of the same work — the overlay the server sent and whatever
// this browser saved — and neither is simply right, so this is the one place that settles them.
// The server's rows stand, its `cleared` tombstones included: that is how a step cleared on a phone
// stays cleared instead of being resurrected by a stale local copy. A mark the server has never
// heard of is not stale, though — it is work done offline or before signing in, still queued for
// the reconcile to push — so it rides on top. And where there is no account overlay to defer to at
// all (an anonymous tree, a local-born one, an unreachable server), the saved copy is the only
// account of this work there is and stands whole.
export function reconcileOverlay(overlay, saved) {
  const base = saved && !overlay.server ? saved : overlay;
  const completed = new Set(base.completed);
  const inProgress = new Set(base.inProgress);

  if (saved && overlay.server) {
    const known = new Set([...overlay.completed, ...overlay.inProgress, ...(overlay.cleared ?? [])]);
    for (const id of saved.completed) if (!known.has(id)) completed.add(id);
    for (const id of saved.inProgress) if (!known.has(id)) inProgress.add(id);
  }

  return {
    completed,
    inProgress,
    startedAt: stampsFor(inProgress, overlay.markedAt, saved?.startedAt),
    completedAt: stampsFor(completed, overlay.markedAt, saved?.completedAt),
  };
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
