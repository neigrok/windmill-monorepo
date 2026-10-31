// Every Board string, phone and desktop alike. Step titles arrive as plain strings.

export const STATE_WORDS = { locked: 'locked', upNext: 'up next', done: 'done' };
export const COLUMN_TITLES = { locked: 'Locked', upNext: 'Up next', done: 'Done' };
export const SORT_LABELS = { roadmap: 'Roadmap order', newest: 'Created · newest', oldest: 'Created · oldest' };

export const LABELS = {
  findStep: 'Find a step',
  filterByKind: 'Filter by kind',
  allKinds: 'All',
  newStep: 'New step',
  recolor: 'Recolor',
  undo: 'Undo',
  allSubtasksDone: 'All subtasks done · Complete step',
};

export const LINK_COPIED = 'Link copied';
export const EMPTY_ROADMAP = { title: 'Your first step', body: 'Give your roadmap a place to start.', action: 'New step' };
export const LOAD_ERROR = {
  title: 'Couldn’t load this roadmap',
  body: 'It may have moved, or the server is unreachable.',
  action: 'Try again',
};
export const SAVE_FAILURE = { body: 'Couldn’t save. Your draft is kept.', retry: 'Retry', keepEditing: 'Keep editing' };
export const DISCARD_DRAFT = { title: 'Discard draft?', body: 'Your changes will be lost.', keepEditing: 'Keep editing', discard: 'Discard' };
export const FILTERED_EMPTY = { title: 'No steps match', action: 'Clear filters' };
export const SYNC_STATUS = { saving: 'Saving…', saved: 'Saved', offline: 'Offline · changes will sync' };
export const REFUSED_SYNC = { body: 'Couldn’t sync this change.', retry: 'Retry', discard: 'Discard change' };
export const ANONYMOUS_OWNER = 'Saved on this device — sign in to keep it';
export const LAPSED_SESSION = 'Signed out — saved on this device';

// Full numbers with thousands separators; `compact` abbreviates from 1,000 for the phone's segments and progress figure.
export function formatCount(count, { compact = false } = {}) {
  if (!compact || count < 1000) return count.toLocaleString('en-US');
  return `${Number((count / 1000).toFixed(1))}k`;
}

export function stepCount(count) {
  return `${formatCount(count)} ${count === 1 ? 'step' : 'steps'}`;
}

export function needsLine({ need, extra, toGo }) {
  return `Needs ${need}${extra > 0 ? ` +${formatCount(extra)}` : ''} · ${formatCount(toGo)} to go`;
}

export function unlocksLine({ first, extra }) {
  return `Unlocks ${first}${extra > 0 ? ` +${formatCount(extra)}` : ''}`;
}

export function lockedStatus({ toGo }) {
  return `Locked · ${formatCount(toGo)} to go`;
}

export function columnHeadingLabel({ column, count }) {
  return `${COLUMN_TITLES[column]}, ${stepCount(count)}`;
}

export function progressFigure({ done, total, compact = false }) {
  return `${formatCount(done, { compact })}/${formatCount(total, { compact })}`;
}

export function progressLabel({ done, total }) {
  return `${formatCount(done)} of ${stepCount(total)} done`;
}

export function showAllDone({ total }) {
  return `Show all ${formatCount(total)}`;
}

export function branchChip({ step }) {
  return `Branch · ${step}`;
}

export function completedToast({ step, unlocked }) {
  if (unlocked.length === 0) return `${step} done`;
  if (unlocked.length === 1) return `${step} done · ${unlocked[0]} up next`;
  return `${step} done · ${formatCount(unlocked.length)} up next`;
}

export function completedOutcome({ unlocked }) {
  if (unlocked.length === 0) return null;
  if (unlocked.length === 1) return `${unlocked[0]} is up next`;
  return `${stepCount(unlocked.length)} up next`;
}

export function resetOutcome({ relocked }) {
  if (relocked === 0) return null;
  return `${stepCount(relocked)} locked again`;
}

export function resetPreview({ relocked }) {
  if (relocked === 0) return null;
  return `Reset returns ${stepCount(relocked)} to Locked`;
}

export function createdToast({ step, column, filterCleared = false }) {
  if (filterCleared) return `${step} added · filter cleared`;
  return `${step} added · ${COLUMN_TITLES[column]}`;
}

export function deletedToast({ step }) {
  return `${step} deleted`;
}

export function recoloredToast({ count }) {
  return `${stepCount(count)} recolored`;
}

export function deletedStepsToast({ count }) {
  return `${stepCount(count)} deleted`;
}

export function deleteStepsAction({ count }) {
  return `Delete ${stepCount(count)}`;
}

export function checkedToast({ item }) {
  return `${item} checked`;
}

export function notDone({ step }) {
  return `${step} isn’t done`;
}

export function roadmapComplete({ total }) {
  return {
    title: total === 1 ? '1 step done' : `All ${stepCount(total)} done`,
    body: 'Add a step whenever you’re ready.',
    share: 'Share it',
  };
}

export function searchEmpty({ query }) {
  const asked = query.trim();
  return { title: `No steps match “${asked}”`, clear: 'Clear search', create: `New step “${asked}”` };
}
