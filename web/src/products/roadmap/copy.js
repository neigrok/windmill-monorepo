// Every string in the roadmap room, phone and desktop alike. Step titles arrive as plain strings; reasonLine reads them off a card.

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
  manageKinds: 'Manage kinds',
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
  activity: 'Activity',
};
export const ROADMAP_SHEET = {
  title: 'Roadmap',
  yourRoadmaps: 'Your roadmaps',
  newRoadmap: 'New roadmap',
  plantedInPublic: 'Planted in public',
  findRoadmap: 'Find a roadmap',
};

export const LINK_COPIED = 'Link copied';
export const EMPTY_ROADMAP = { title: 'Your first step', body: 'Give your roadmap a place to start.', action: 'New step' };
export const LOAD_ERROR = {
  title: 'Couldn’t load this roadmap',
  body: 'It may have moved, or the server is unreachable.',
  action: 'Try again',
};
export const GRAPH_LOAD = { planting: 'Planting the tree…', home: 'Your trees' };
export const SAVE_FAILURE = { body: 'Couldn’t save. Your draft is kept.', retry: 'Retry', keepEditing: 'Keep editing' };
export const DISCARD_DRAFT = { title: 'Discard draft?', body: 'Your changes will be lost.', keepEditing: 'Keep editing', discard: 'Discard' };
export const FILTERED_EMPTY = { title: 'No steps match', action: 'Clear filters' };
const CLEAR_BOTH = 'Clear both';
export const SYNC_STATUS = { saving: 'Saving…', saved: 'Saved', offline: 'Offline · changes will sync' };
export const SYNC_OFFLINE_SHORT = 'Offline';
export const REFUSED_SYNC = { body: 'Couldn’t sync this change.', retry: 'Retry', discard: 'Discard change' };
export const ANONYMOUS_OWNER = 'Saved on this device — sign in to keep it';
export const LAPSED_SESSION = 'Signed out — saved on this device';
export const DEVICE_REFUSED = { title: 'Couldn’t open this device’s saved work', body: 'Reload to try again.' };
export const FORK_OFFER = 'Fork this tree';
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
  subtask: 'Subtask',
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
export const BULK = { region: 'Selection', done: 'Done', recolor: 'Recolor' };

export const COMPACT_COUNT_THRESHOLD = 1000;
const MILLION = 1_000_000;
const COMPACT_DECIMALS = 1;

// Full numbers with thousands separators; `compact` abbreviates from 1,000 for the phone's segments and progress figure.
export function formatCount(count, { compact = false } = {}) {
  if (!compact || count < COMPACT_COUNT_THRESHOLD) return count.toLocaleString('en-US');
  const thousands = Number((count / COMPACT_COUNT_THRESHOLD).toFixed(COMPACT_DECIMALS));
  if (thousands < COMPACT_COUNT_THRESHOLD) return `${thousands}k`;
  return `${Number((count / MILLION).toFixed(COMPACT_DECIMALS))}m`;
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

export function unlocksWhen({ step }) {
  return `Unlocks when ‘${step}’ is done.`;
}

export function selectingAnnouncement({ count }) {
  return `Selecting. ${selectedCount({ count })}.`;
}

export function selectedCount({ count }) {
  return `${formatCount(count)} selected`;
}

// A Locked card names what it needs, an Up next card what it opens; Done and a card that opens nothing say neither.
export function reasonLine({ needs, unlocks }) {
  if (needs) return `Needs ${needs.need.label}${needs.extra > 0 ? ` +${formatCount(needs.extra)}` : ''} · ${formatCount(needs.toGo)} to go`;
  if (unlocks) return `Unlocks ${unlocks.first.label}${unlocks.extra > 0 ? ` +${formatCount(unlocks.extra)}` : ''}`;
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

export function completedToast({ step, unlocked = [], unlockedCount = unlocked.length }) {
  if (unlockedCount === 0) return `${step} done`;
  if (unlockedCount === 1 && unlocked.length === 1) return `${step} done · ${unlocked[0]} up next`;
  return `${step} done · ${formatCount(unlockedCount)} up next`;
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

// A fresh plant's arrival ends on this line; a quest names itself.
export function plantedToast({ quest = false, count, done = 0 }) {
  return `${quest ? 'Quest' : 'Roadmap'} planted · ${stepCount(count)}${done > 0 ? ` · ${formatCount(done)} already done` : ''}`;
}

export function welcomeBackToast({ count }) {
  return `Welcome back · ${stepCount(count)} done since your last visit`;
}

export function forkedToast({ count }) {
  return `Forked — ${stepCount(count)} planted`;
}

export function deletedToast({ step }) {
  return `${step} deleted`;
}

export function deleteFailedToast({ step, count = 1 }) {
  return `Couldn’t delete ${count > 1 ? stepCount(count) : step || STEP_DETAIL.unnamed}`;
}

export function recoloredToast({ count }) {
  return `${stepCount(count)} recolored`;
}

export function deletedStepsToast({ count }) {
  return `${stepCount(count)} deleted`;
}

export const GRAPH_TOAST = {
  stepDeleted: 'Step deleted',
  stepAdded: 'Step added',
  renamed: 'Renamed',
  recolored: 'Recolored',
  linked: 'Linked',
  linkRemoved: 'Link removed',
  restore: 'Restore',
  undrawnEdit: 'That edit could not be drawn — the picture is one step behind',
};

export const TEND_TOAST = { why: 'Why?', hide: 'Hide', reverted: 'AI changes reverted' };

export function deletedSelectionToast({ steps, links }) {
  const parts = [];
  if (steps > 0) parts.push(stepCount(steps));
  if (links > 0) parts.push(`${formatCount(links)} ${links === 1 ? 'link' : 'links'}`);
  return `${parts.join(' and ')} deleted`;
}

export function graftedToast({ count, under = null }) {
  return `Added ${stepCount(count)}${under ? ` under “${under}”` : ''}`;
}

export function keptStepsToast({ count }) {
  return `${stepCount(count)} kept under a deleted node`;
}

export function cycleToast({ ring }) {
  return `Cycle: ${ring.join(' → ')} — remove a link to fix it`;
}

export function deleteStepsAction({ count }) {
  return `Delete ${stepCount(count)}`;
}

export function deleteCostLine(childCount) {
  if (childCount <= 0) return 'Removes this step';
  if (childCount === 1) return 'Removes this step · 1 branch resplices';
  return `Removes this step · ${childCount} branches resplice`;
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
  if (unmet.length === 1) return { column: 'locked', body: `${unmet[0]} isn’t done` };
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

export function roadmapComplete({ total }) {
  return {
    title: total === 1 ? '1 step done' : `All ${stepCount(total)} done`,
    body: 'Add a step whenever you’re ready.',
    share: 'Share it',
  };
}

// What an emptied column says, by the way out it names: the search, the kinds or both.
export function emptyColumn({ recovery, search }) {
  if (recovery === 'kinds') return { title: FILTERED_EMPTY.title, action: FILTERED_EMPTY.action };
  return { title: noStepsMatch({ query: search }), action: recovery === 'both' ? CLEAR_BOTH : LABELS.clearSearch };
}

export function removeChip({ label }) {
  return `Remove ${label}`;
}

export function sortButtonLabel({ sort }) {
  return `${SORT_MENU.title}: ${SORT_MENU.options[sort]}`;
}

// The step page and modal.
export const STEP_DETAIL = {
  select: 'Select',
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

export const REFUSED_CAPACITY = { title: 'This roadmap is at its limit.', body: 'This change can’t sync.' };

export function refusedSyncBody({ count }) {
  if (count > 1) return `Couldn’t sync ${formatCount(count)} changes.`;
  return REFUSED_SYNC.body;
}

export function discardChanges({ count }) {
  if (count > 1) return `Discard ${formatCount(count)} changes`;
  return REFUSED_SYNC.discard;
}

export function roadmapsHeading({ count }) {
  return `${ROADMAP_SHEET.yourRoadmaps} · ${formatCount(count)}`;
}

export function roadmapMatches({ shown, total }) {
  return `${formatCount(shown)} of ${formatCount(total)} roadmaps`;
}

export const DEMO_BYLINE = { wide: 'Windmill sample', phone: 'Sample' };
export const ASK_AI_PLACEHOLDER = {
  phone: 'What should change?',
  wide: 'Tell the tree what to change…',
  empty: 'What do you want to learn or build?',
};
export const OPEN_STEP = 'Open step';
export const ACTIVITY = {
  heading: 'Activity',
  empty: 'No activity yet — changes you make will appear here.',
};

export const GRAPH_UNAVAILABLE = 'Graph needs WebGL2, which this browser doesn’t support.';
