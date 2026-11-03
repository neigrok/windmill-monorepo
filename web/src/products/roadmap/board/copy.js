// Every Board string, phone and desktop alike. Step titles arrive as plain strings; reasonLine reads them off a card.

export const STATE_WORDS = { locked: 'locked', upNext: 'up next', done: 'done' };
export const COLUMN_TITLES = { locked: 'Locked', upNext: 'Up next', done: 'Done' };
export const SORT_LABELS = { roadmap: 'Roadmap order', newest: 'Created · newest', oldest: 'Created · oldest' };
export const SHORTCUTS_TITLE = 'Keyboard shortcuts · Board';
export const SORT_MENU = {
  title: 'Sort',
  created: 'Created',
  options: { roadmap: 'Roadmap order', newest: 'Newest first', oldest: 'Oldest first' },
  roadmapDetail: 'Closest to start, then most unlocks',
};

export const LABELS = {
  columns: 'Columns',
  findStep: 'Find a step',
  filterByKind: 'Filter by kind',
  allKinds: 'All',
  newStep: 'New step',
  recolor: 'Recolor',
  undo: 'Undo',
  show: 'Show',
  sort: 'Sort',
  branch: 'Branch',
  clearBranch: 'Clear branch',
  clearSearch: 'Clear search',
  close: 'Close',
};

export const VIEW_SWITCH = { group: 'View', board: 'Board', graph: 'Graph' };
export const ROADMAP_VERBS = {
  askAI: 'Ask AI',
  share: 'Share',
  shareRoadmap: 'Share roadmap',
  more: 'More',
  export: 'Export',
  settings: 'Settings',
  keyboardShortcuts: 'Keyboard shortcuts',
  fork: 'Fork',
};
export const ROADMAP_SHEET = {
  title: 'Roadmap',
  yourRoadmaps: 'Your roadmaps',
  newRoadmap: 'New roadmap',
  plantedInPublic: 'Planted in public',
};
export const NOTHING_UP_NEXT = 'Nothing up next yet';

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
export const CLEAR_BOTH = 'Clear both';
export const SYNC_STATUS = { saving: 'Saving…', saved: 'Saved', offline: 'Offline · changes will sync' };
export const REFUSED_SYNC = { body: 'Couldn’t sync this change.', retry: 'Retry', discard: 'Discard change' };
export const ANONYMOUS_OWNER = 'Saved on this device — sign in to keep it';
export const LAPSED_SESSION = 'Signed out — saved on this device';
export const DELETE_CONFIRM = { cancel: 'Cancel', delete: 'Delete' };
export const COMPOSER = {
  title: 'New step',
  cancel: 'Cancel',
  name: 'Name',
  namePlaceholder: 'Name this step',
  nameRequired: 'Enter a name for this step.',
  description: 'Description · optional',
  descriptionPlaceholder: 'What does this step cover?',
  kind: 'Kind',
  prerequisites: 'Prerequisites',
  none: 'None',
  create: 'Create step',
};
export const EDIT_STEP = { title: 'Edit step', save: 'Save' };
export const PICKER = {
  title: 'Prerequisites',
  allSteps: 'All steps',
  cantBe: 'Can’t be prerequisites',
  apply: 'Apply',
  cancel: 'Cancel',
  selectionKept: 'Your selection is kept.',
  clearSearch: 'Clear search',
  startingStep: 'a starting step',
  thisStep: 'This step',
  comesAfter: 'Comes after this step',
  nowComesAfter: 'Now comes after this step',
};
export const WORKSPACE = {
  subtasks: 'Subtasks',
  addSubtask: 'Add subtask',
  note: 'Note',
  edit: 'Edit',
  personalLinks: 'Personal links',
  addLink: 'Add link',
  removeLink: 'Remove link',
  removeSubtask: 'Remove subtask',
};
export const NOTE_EDITOR = {
  title: 'Edit note',
  cancel: 'Cancel',
  save: 'Save',
  bold: 'Bold',
  italic: 'Italic',
  link: 'Link',
  list: 'List',
  text: 'Text',
  url: 'URL',
  urlPlaceholder: 'Paste or type URL',
  apply: 'Apply',
};
export const BULK = { done: 'Done', recolor: 'Recolor' };

// Full numbers with thousands separators; `compact` abbreviates from 1,000 for the phone's segments and progress figure.
export function formatCount(count, { compact = false } = {}) {
  if (!compact || count < 1000) return count.toLocaleString('en-US');
  const thousands = Number((count / 1000).toFixed(1));
  if (thousands < 1000) return `${thousands}k`;
  return `${Number((count / 1_000_000).toFixed(1))}m`;
}

export function stepCount(count) {
  return `${formatCount(count)} ${count === 1 ? 'step' : 'steps'}`;
}

export function nextChip({ count }) {
  return `Next · ${formatCount(count)}`;
}

export function upNextCount({ count }) {
  return `${formatCount(count)} up next`;
}

export function moreUpNext({ count }) {
  return `+ ${formatCount(count)} more up next`;
}

export function upNextIn({ lens }) {
  return `Up next in ${lens}`;
}

export function unlocksWhen({ step }) {
  return `Unlocks when ‘${step}’ is done.`;
}

export function selectedCount({ count }) {
  return `${formatCount(count)} selected`;
}

export function needsLine({ need, extra, toGo }) {
  return `Needs ${need}${extra > 0 ? ` +${formatCount(extra)}` : ''} · ${formatCount(toGo)} to go`;
}

export function unlocksLine({ first, extra }) {
  return `Unlocks ${first}${extra > 0 ? ` +${formatCount(extra)}` : ''}`;
}

// A Locked card names what it needs, an Up next card what it opens; Done and a card that opens nothing say neither.
export function reasonLine({ needs, unlocks }) {
  if (needs) return needsLine({ need: needs.need.label, extra: needs.extra, toGo: needs.toGo });
  if (unlocks) return unlocksLine({ first: unlocks.first.label, extra: unlocks.extra });
  return null;
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

export function exactProgress({ done, upNext, locked }) {
  return `${formatCount(done)} done · ${formatCount(upNext)} up next · ${formatCount(locked)} locked`;
}

export function showColumn({ column }) {
  return `${LABELS.show} ${COLUMN_TITLES[column]}`;
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

export function completedStepsToast({ count, unlocked }) {
  if (unlocked > 0) return `${stepCount(count)} done · ${formatCount(unlocked)} up next`;
  return `${stepCount(count)} done`;
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

export function deleteConfirm({ step }) {
  return `Delete ${step}?`;
}

export function completeStepAction({ step }) {
  return `Complete ${step}`;
}

export function placementPreview({ prerequisites, unmet }) {
  if (prerequisites.length === 0) return { column: 'upNext', body: 'No prerequisites: lands in Up next.' };
  if (unmet.length === 0) return { column: 'upNext', body: 'Prerequisites done: lands in Up next.' };
  if (unmet.length === 1) return { column: 'locked', body: notDone({ step: unmet[0] }) };
  if (unmet.length === 2) return { column: 'locked', body: `${unmet[0]} and ${unmet[1]} aren’t done` };
  return { column: 'locked', body: `${unmet[0]} and ${formatCount(unmet.length - 1)} more aren’t done` };
}

export function prerequisiteNames(labels) {
  return labels.join(', ');
}

export function pickerFor({ step, total }) {
  const name = step.trim();
  if (!name) return null;
  if (total == null) return `For ${name}`;
  return `For ${name} · ${stepCount(total)}`;
}

export function matchCount({ shown, count, total, band }) {
  const matches = `${formatCount(count)} ${count === 1 ? 'match' : 'matches'}`;
  const paged = shown < count ? `${formatCount(shown)} of ${matches}` : matches;
  if (band === 'desktop' && total != null) return `${paged} in ${stepCount(total)}`;
  return paged;
}

export function afterStep({ step }) {
  return `after ${step}`;
}

export function leftSelection({ step }) {
  return `${step} now comes after this step, so it left your selection.`;
}

export function noStepsMatch({ query }) {
  return `No steps match “${query.trim()}”`;
}

export function showMore({ count }) {
  return `Show ${formatCount(count)} more`;
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
  return { title: `No steps match “${asked}”`, clear: LABELS.clearSearch, create: `New step “${asked}”` };
}

// What an emptied column says, by the way out it names: the search, the kinds or both.
export function emptyColumn({ recovery, search }) {
  if (recovery === 'kinds') return { title: FILTERED_EMPTY.title, action: FILTERED_EMPTY.action };
  const { title, clear } = searchEmpty({ query: search });
  return { title, action: recovery === 'both' ? CLEAR_BOTH : clear };
}

export function removeChip({ label }) {
  return `Remove ${label}`;
}

export function sortButtonLabel({ sort }) {
  return `${SORT_MENU.title}: ${SORT_MENU.options[sort]}`;
}

// The step page and modal.
export const STEP_DETAIL = {
  sections: { overview: 'Overview', workspace: 'Workspace', history: 'History' },
  stepLinks: 'Step links',
  prerequisites: 'Prerequisites',
  unlocks: 'Unlocks',
  complete: 'Complete',
  reset: 'Reset',
  close: 'Close',
  more: 'More',
  back: 'Back',
  copyLink: 'Copy link',
  openInGraph: 'Open in Graph',
  deleteStep: 'Delete step',
  editStep: 'Edit step',
  editNote: 'Edit note',
  viewBranch: 'View branch',
  subtasks: 'Subtasks',
  addSubtask: 'Add subtask',
  subtaskOffer: { body: 'All subtasks done', action: 'Complete step' },
  unnamed: 'Unnamed step',
};

export function prerequisitesTally({ done, total }) {
  return `${formatCount(done)} / ${formatCount(total)}`;
}

export function subtaskTally({ done, total }) {
  return `${done} of ${total}`;
}

export function backTo({ screen }) {
  return `${STEP_DETAIL.back} to ${screen}`;
}

export function draftLine({ step }) {
  return `for ${step}`;
}

export const WORKSPACE_EMPTY = { body: 'Add something for this step.', addNote: 'Add note' };
export const NEW_LINK = { title: 'New link' };
export const HISTORY_EMPTY = 'No changes yet';
