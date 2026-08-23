// `now` is handed in so one bulk mark carries one moment.

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

// Only one milestone is announced; the caller marks them all offered.
export function milestoneAnnouncement(fresh) {
  if (!fresh || fresh.length === 0) return null;
  const best = fresh.find((milestone) => milestone.kind === 'crown')
    ?? fresh.reduce((a, b) => (b.done > a.done ? b : a));
  if (best.kind === 'crown') {
    return { summary: `Tree complete — ${best.total}/${best.total} steps.`, label: 'Share it' };
  }
  return { summary: `Branch complete: ${best.label} · ${best.done}/${best.total} steps`, label: 'Share the moment' };
}
