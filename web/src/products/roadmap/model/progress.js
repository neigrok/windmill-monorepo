import { UnlockRules } from './UnlockRules.js';

// `now` is handed in so one bulk mark carries one moment.
export function advanceProgress(progress, ids, target, now) {
  if (target !== 'complete' && target !== 'none') throw new Error(`Unknown progress status "${target}"`);
  const completed = new Set(progress.completed);
  const completedAt = { ...progress.completedAt };

  for (const id of ids) {
    if (target === 'complete') {
      completed.add(id);
      completedAt[id] = now;
      continue;
    }
    completed.delete(id);
    delete completedAt[id];
  }

  return { completed, completedAt };
}

export function progressChanges(tree, before, after) {
  const previousStates = UnlockRules.derive(tree, before);
  const nextStates = UnlockRules.derive(tree, after);
  const completed = [];
  const unlocked = [];
  for (const [id, state] of nextStates) {
    const previous = previousStates.get(id);
    if (state === 'complete' && previous !== 'complete') completed.push(id);
    if (state === 'available' && previous === 'locked') unlocked.push(id);
  }
  return { completed, unlocked };
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
