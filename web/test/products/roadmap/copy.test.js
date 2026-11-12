import test from 'node:test';
import assert from 'node:assert/strict';

import { Opening } from '../../../src/products/roadmap/model/Opening.js';
import {
  treeBand,
  treeLine,
  openTreeStated,
  treeState,
  treeProgress,
  TREE_TOAST,
  treeTitle,
  DEMO_COPY,
  GRAPH_UNAVAILABLE,
  STATE_WORDS,
  COLUMN_TITLES,
  SORT_LABELS,
  SHORTCUTS_TITLE,
  SORT_MENU,
  LABELS,
  ROADMAP_VERBS,
  ROADMAP_SHEET,
  nextChip,
  upNextCount,
  unlocksWhen,
  completedStepsToast,
  exactProgress,
  LINK_COPIED,
  EMPTY_ROADMAP,
  LOAD_ERROR,
  SAVE_FAILURE,
  DISCARD_DRAFT,
  FILTERED_EMPTY,
  SYNC_STATUS,
  SYNC_OFFLINE_SHORT,
  REFUSED_SYNC,
  ANONYMOUS_OWNER,
  LAPSED_SESSION,
  FORK_OFFER,
  formatCount,
  lockedStatus,
  columnHeadingLabel,
  progressFigure,
  progressLabel,
  showAllDone,
  showColumn,
  branchChip,
  completedToast,
  completedOutcome,
  resetOutcome,
  resetPreview,
  createdToast,
  deletedToast,
  recoloredToast,
  deletedStepsToast,
  deleteStepsAction,
  checkedToast,
  deleteCostLine,
  roadmapComplete,
  emptyColumn,
  reasonLine,
  removeChip,
  sortButtonLabel,
  DELETE_CONFIRM,
  COMPOSER,
  EDIT_STEP,
  PICKER,
  WORKSPACE,
  NOTE_EDITOR,
  BULK,
  selectedCount,
  selectingAnnouncement,
  leftSelection,
  subtaskTally,
  deleteConfirm,
  completeStepAction,
  placementPreview,
  prerequisiteNames,
  pickerFor,
  matchCount,
  afterStep,
  noStepsMatch,
  showMore,
  draftLine,
} from '../../../src/products/roadmap/copy.js';

test('copy — the canon strings the demo speaks verbatim', () => {
  assert.equal(DEMO_COPY.coachSentence, 'This step is up next — mark it done.');
  assert.equal(DEMO_COPY.coachButton, 'Mark it done');
  assert.equal(DEMO_COPY.unlockToast, 'Rig the boat yourself done · 2 up next');
});

test('copy — compact offline status', () => {
  assert.equal(SYNC_OFFLINE_SHORT, 'Offline');
});

test('copy — reader Fork offer', () => {
  assert.equal(FORK_OFFER, 'Fork this tree');
});

test('copy — one word per state, one title per column, one label per sort', () => {
  assert.deepEqual(STATE_WORDS, { locked: 'locked', upNext: 'up next', done: 'done' });
  assert.deepEqual(COLUMN_TITLES, { locked: 'Locked', upNext: 'Up next', done: 'Done' });
  assert.deepEqual(SORT_LABELS, { roadmap: 'Roadmap order', newest: 'Created · newest', oldest: 'Created · oldest' });
  assert.deepEqual(LABELS, {
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
  });
  assert.deepEqual(SORT_MENU, {
    title: 'Sort',
    created: 'Created',
    options: { roadmap: 'Roadmap order', newest: 'Newest first', oldest: 'Oldest first' },
    roadmapDetail: 'Closest to start, then most unlocks',
  });
});

test('copy — counts are full with separators, and compact from 1,000 only when asked', () => {
  assert.deepEqual([0, 999, 1000, 3200, 12345].map((count) => formatCount(count)), ['0', '999', '1,000', '3,200', '12,345']);
  assert.deepEqual([999, 1000, 1770, 1800, 3200, 12345, 999_949, 999_950, 1_250_000].map((count) => formatCount(count, { compact: true })), [
    '999', '1k', '1.8k', '1.8k', '3.2k', '12.3k', '999.9k', '1m', '1.3m',
  ]);
});

test('copy — card reasons and the locked status read the structured reasons', () => {
  assert.equal(reasonLine({ needs: { need: { label: 'Read the wind' }, extra: 0, toGo: 1 } }), 'Needs Read the wind · 1 to go');
  assert.equal(reasonLine({ needs: { need: { label: 'Sail a triangle' }, extra: 1, toGo: 4 } }), 'Needs Sail a triangle +1 · 4 to go');
  assert.equal(reasonLine({ unlocks: { first: { label: 'Leave the dock' }, extra: 0 } }), 'Unlocks Leave the dock');
  assert.equal(reasonLine({ unlocks: { first: { label: 'Tie a bowline' }, extra: 1 } }), 'Unlocks Tie a bowline +1');
  assert.equal(lockedStatus({ toGo: 1 }), 'Locked · 1 to go');
});

test('copy — headings, progress and the Done fold speak in steps', () => {
  assert.equal(columnHeadingLabel({ column: 'upNext', count: 2 }), 'Up next, 2 steps');
  assert.equal(columnHeadingLabel({ column: 'locked', count: 1 }), 'Locked, 1 step');
  assert.equal(progressFigure({ done: 3, total: 8 }), '3/8');
  assert.equal(progressFigure({ done: 3200, total: 5000 }), '3,200/5,000');
  assert.equal(progressFigure({ done: 3200, total: 5000, compact: true }), '3.2k/5k');
  assert.equal(progressLabel({ done: 3, total: 8 }), '3 of 8 steps done');
  assert.equal(progressLabel({ done: 0, total: 1 }), '0 of 1 step done');
  assert.equal(showAllDone({ total: 3200 }), 'Show all 3,200');
  assert.deepEqual(['locked', 'done'].map((column) => showColumn({ column })), ['Show Locked', 'Show Done']);
  assert.equal(branchChip({ step: 'Read the wind' }), 'Branch · Read the wind');
});

test('copy — completion speaks once: a toast on the Board, a secondary line on the page', () => {
  assert.deepEqual([[], ['Leave the dock'], ['Leave the dock', 'Sail a triangle']].map((unlocked) => completedToast({ step: 'Read the wind', unlocked })), [
    'Read the wind done',
    'Read the wind done · Leave the dock up next',
    'Read the wind done · 2 up next',
  ]);
  assert.deepEqual([[], ['Leave the dock'], ['Leave the dock', 'Sail a triangle']].map((unlocked) => completedOutcome({ unlocked })), [
    null,
    'Leave the dock is up next',
    '2 steps up next',
  ]);
});

test('copy — reset is quiet: an outcome line and a preview, nothing when nothing relocks', () => {
  assert.deepEqual([0, 1, 2].map((relocked) => resetOutcome({ relocked })), [null, '1 step locked again', '2 steps locked again']);
  assert.deepEqual([0, 1, 2].map((relocked) => resetPreview({ relocked })), [
    null, 'Reset returns 1 step to Locked', 'Reset returns 2 steps to Locked',
  ]);
});

test('copy — create, delete, bulk and checklist toasts', () => {
  assert.equal(createdToast({ step: 'Reefing basics', column: 'locked' }), 'Reefing basics added · Locked');
  assert.equal(createdToast({ step: 'Reefing basics', column: 'locked', filterCleared: true }), 'Reefing basics added · filter cleared');
  assert.equal(deletedToast({ step: 'Rig the boat' }), 'Rig the boat deleted');
  assert.equal(recoloredToast({ count: 3 }), '3 steps recolored');
  assert.equal(deletedStepsToast({ count: 3 }), '3 steps deleted');
  assert.equal(deletedStepsToast({ count: 1 }), '1 step deleted');
  assert.equal(deleteStepsAction({ count: 3 }), 'Delete 3 steps');
  assert.equal(deleteStepsAction({ count: 1 }), 'Delete 1 step');
  assert.equal(checkedToast({ item: 'Try a small turn' }), 'Try a small turn checked');
  assert.equal(LINK_COPIED, 'Link copied');
});

test('copy — empty, complete, failure and recovery states', () => {
  assert.deepEqual(EMPTY_ROADMAP, { title: 'Your first step', body: 'Give your roadmap a place to start.', action: 'New step' });
  assert.deepEqual(roadmapComplete({ total: 8 }), {
    title: 'All 8 steps done', body: 'Add a step whenever you’re ready.', share: 'Share it',
  });
  assert.deepEqual(roadmapComplete({ total: 1 }), {
    title: '1 step done', body: 'Add a step whenever you’re ready.', share: 'Share it',
  });
  assert.deepEqual(LOAD_ERROR, {
    title: 'Couldn’t load this roadmap', body: 'It may have moved, or the server is unreachable.', action: 'Try again',
  });
  assert.deepEqual(SAVE_FAILURE, { body: 'Couldn’t save. Your draft is kept.', retry: 'Retry', keepEditing: 'Keep editing' });
  assert.deepEqual(DISCARD_DRAFT, {
    title: 'Discard draft?', body: 'Your changes will be lost.', keepEditing: 'Keep editing', discard: 'Discard',
  });
  assert.deepEqual(FILTERED_EMPTY, { title: 'No steps match', action: 'Clear filters' });
  assert.deepEqual(emptyColumn({ recovery: 'search', search: ' astronomy ' }), { title: 'No steps match “astronomy”', action: 'Clear search' });
});

test('copy — sync and session lines', () => {
  assert.deepEqual(SYNC_STATUS, { saving: 'Saving…', saved: 'Saved', offline: 'Offline · changes will sync' });
  assert.deepEqual(REFUSED_SYNC, { body: 'Couldn’t sync this change.', retry: 'Retry', discard: 'Discard change' });
  assert.equal(ANONYMOUS_OWNER, 'Saved on this device — sign in to keep it');
  assert.equal(LAPSED_SESSION, 'Signed out — saved on this device');
});

test('copy — an emptied column names its way out: the search, the kinds or both; a chip names what it removes', () => {
  assert.deepEqual(['search', 'kinds', 'both'].map((recovery) => emptyColumn({ recovery, search: ' wind ' })), [
    { title: 'No steps match “wind”', action: 'Clear search' },
    { title: 'No steps match', action: 'Clear filters' },
    { title: 'No steps match “wind”', action: 'Clear both' },
  ]);
  assert.equal(removeChip({ label: 'Created · newest' }), 'Remove Created · newest');
  assert.deepEqual(['roadmap', 'newest'].map((sort) => sortButtonLabel({ sort })), ['Sort: Roadmap order', 'Sort: Newest first']);
});

test('copy — the step page and modal', async () => {
  const { STEP_DETAIL, prerequisitesTally, backTo } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(STEP_DETAIL, {
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
  });
  assert.deepEqual([prerequisitesTally({ done: 1, total: 2 }), prerequisitesTally({ done: 1200, total: 3200 }), backTo({ screen: 'Learn to sail' })],
    ['1 / 2', '1,200 / 3,200', 'Back to Learn to sail']);
});

test('copy — delete confirmation and completion name the step', () => {
  assert.deepEqual(DELETE_CONFIRM, { cancel: 'Cancel', delete: 'Delete' });
  assert.equal(deleteConfirm({ step: 'Read the wind' }), 'Delete Read the wind?');
  assert.equal(completeStepAction({ step: 'Read the wind' }), 'Complete Read the wind');
});

test('copy — the composer labels and validation', () => {
  assert.deepEqual(COMPOSER, {
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
  });
});

test('copy — placement names unmet prerequisites in chosen order', () => {
  const prerequisites = ['Read the wind', 'Tie a bowline', 'Rig the boat', 'Leave the dock'];
  assert.deepEqual(placementPreview({ prerequisites: [], unmet: [] }), {
    column: 'upNext', body: 'No prerequisites: lands in Up next.',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: [] }), {
    column: 'upNext', body: 'Prerequisites done: lands in Up next.',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: prerequisites.slice(0, 1) }), {
    column: 'locked', body: 'Read the wind isn’t done',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: prerequisites.slice(0, 2) }), {
    column: 'locked', body: 'Read the wind and Tie a bowline aren’t done',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: prerequisites.slice(0, 3) }), {
    column: 'locked', body: 'Read the wind and 2 more aren’t done',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: prerequisites.slice(1) }), {
    column: 'locked', body: 'Tie a bowline and 2 more aren’t done',
  });
  assert.deepEqual(placementPreview({ prerequisites, unmet: prerequisites }), {
    column: 'locked', body: 'Read the wind and 3 more aren’t done',
  });
  assert.deepEqual([[], ['Read the wind'], prerequisites].map(prerequisiteNames), [
    '', 'Read the wind', 'Read the wind, Tie a bowline, Rig the boat, Leave the dock',
  ]);
});

test('copy — the prerequisite picker labels and header', () => {
  assert.deepEqual(PICKER, {
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
  });
  assert.equal(pickerFor({ step: 'Reefing basics' }), 'For Reefing basics');
  assert.equal(pickerFor({ step: 'Reefing basics', total: 8 }), 'For Reefing basics · 8 steps');
  assert.equal(pickerFor({ step: 'Reefing basics', total: 5000 }), 'For Reefing basics · 5,000 steps');
  assert.equal(pickerFor({ step: ' Reefing basics ', total: 1 }), 'For Reefing basics · 1 step');
  assert.equal(pickerFor({ step: 'Reefing basics', total: 0 }), 'For Reefing basics · 0 steps');
  assert.equal(pickerFor({ step: '' }), null);
  assert.equal(pickerFor({ step: ' ', total: 8 }), null);
});

test('copy — picker match counts include paging and desktop roadmap totals', () => {
  assert.equal(matchCount({ shown: 0, count: 0, total: 8, band: 'phone' }), '0 matches');
  assert.equal(matchCount({ shown: 1, count: 1, total: 8, band: 'phone' }), '1 match');
  assert.equal(matchCount({ shown: 4, count: 4, total: 8, band: 'phone' }), '4 matches');
  assert.equal(matchCount({ shown: 20, count: 64, total: 5000, band: 'phone' }), '20 of 64 matches');
  assert.equal(matchCount({ shown: 4, count: 4, total: 5000, band: 'desktop' }), '4 matches in 5,000 steps');
  assert.equal(matchCount({ shown: 20, count: 64, total: 5000, band: 'desktop' }), '20 of 64 matches in 5,000 steps');
  assert.equal(matchCount({ shown: 1, count: 1, total: 1, band: 'desktop' }), '1 match in 1 step');
  assert.equal(matchCount({ shown: 4, count: 4, band: 'desktop' }), '4 matches');
  assert.equal(matchCount({ shown: 4, count: 4, total: 5000, band: 'tablet' }), '4 matches');
  assert.equal(matchCount({ shown: 1000, count: 2000, total: 5000, band: 'phone' }), '1,000 of 2,000 matches');
});

test('copy — picker collision context, search and paging action', () => {
  assert.equal(afterStep({ step: 'Read the wind' }), 'after Read the wind');
  assert.equal(noStepsMatch({ query: ' reef ' }), 'No steps match “reef”');
  assert.equal(showMore({ count: 20 }), 'Show 20 more');
  assert.equal(showMore({ count: 4 }), 'Show 4 more');
  assert.equal(showMore({ count: 1000 }), 'Show 1,000 more');
});

test('copy — the tablet draft context uses lowercase for without a roadmap count', () => {
  assert.equal(draftLine({ step: 'Reefing basics' }), 'for Reefing basics');
  assert.equal(draftLine({ step: 'Passage plan' }), 'for Passage plan');
  assert.equal(draftLine({ step: '' }), 'for ');
});

test('copy — edit and workspace labels match the wave 5 contract', () => {
  assert.deepEqual(EDIT_STEP, { title: 'Edit step', save: 'Save' });
  assert.deepEqual(WORKSPACE, {
    subtask: 'Subtask',
    subtasks: 'Subtasks',
    addSubtask: 'Add subtask',
    note: 'Note',
    edit: 'Edit',
    personalLinks: 'Personal links',
    addLink: 'Add link',
    removeLink: 'Remove link',
    removeSubtask: 'Remove subtask',
  });
  assert.deepEqual(NOTE_EDITOR, {
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
  });
  assert.equal(leftSelection({ step: 'Read the wind' }), 'Read the wind now comes after this step, so it left your selection.');
  assert.deepEqual([
    subtaskTally({ done: 0, total: 0 }),
    subtaskTally({ done: 1, total: 2 }),
    subtaskTally({ done: 1200, total: 3200 }),
  ], ['0 of 0', '1 of 2', '1200 of 3200']);
});

test('copy — bulk selection formats full counts', () => {
  assert.deepEqual(BULK, { region: 'Selection', done: 'Done', recolor: 'Recolor' });
  assert.equal(selectingAnnouncement({ count: 1 }), 'Selecting. 1 selected.');
  assert.deepEqual([0, 1, 3, 1200].map((count) => selectedCount({ count })), [
    '0 selected', '1 selected', '3 selected', '1,200 selected',
  ]);
});

test('Board shortcuts title is pinned copy', () => {
  assert.equal(SHORTCUTS_TITLE, 'Keyboard shortcuts · Board');
});

test('approved workspace gaps have one pinned string each', async () => {
  const { WORKSPACE_EMPTY, NEW_LINK, HISTORY_EMPTY } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(WORKSPACE_EMPTY, { body: 'Add something for this step.', addNote: 'Add note' });
  assert.deepEqual(NEW_LINK, { title: 'New link' });
  assert.equal(HISTORY_EMPTY, 'No changes yet');
});

test('copy — roadmap verbs and sheet labels match the wave 6 contract', () => {
  assert.deepEqual(ROADMAP_VERBS, {
    askAI: 'Ask AI',
    share: 'Share',
    shareRoadmap: 'Share roadmap',
    more: 'More',
    export: 'Export',
    settings: 'Settings',
    keyboardShortcuts: 'Keyboard shortcuts',
    fork: 'Fork',
    activity: 'Activity',
  });
  assert.deepEqual(ROADMAP_SHEET, {
    title: 'Roadmap',
    yourRoadmaps: 'Your roadmaps',
    newRoadmap: 'New roadmap',
    plantedInPublic: 'Planted in public',
    findRoadmap: 'Find a roadmap',
  });
});

test('copy — roadmap next counts use full numbers and the pinned state words', () => {
  assert.deepEqual([0, 1, 2, 1200].map((count) => nextChip({ count })), [
    'Next · 0', 'Next · 1', 'Next · 2', 'Next · 1,200',
  ]);
  assert.deepEqual([0, 1, 2, 1200].map((count) => upNextCount({ count })), [
    '0 up next', '1 up next', '2 up next', '1,200 up next',
  ]);
  assert.equal(unlocksWhen({ step: 'Read the wind' }), 'Unlocks when ‘Read the wind’ is done.');
});

test('copy — completed step totals include up next only when positive', () => {
  assert.equal(completedStepsToast({ count: 0, unlocked: 0 }), '0 steps done');
  assert.equal(completedStepsToast({ count: 1, unlocked: 0 }), '1 step done');
  assert.equal(completedStepsToast({ count: 2, unlocked: 0 }), '2 steps done');
  assert.equal(completedStepsToast({ count: 1, unlocked: 1 }), '1 step done · 1 up next');
  assert.equal(completedStepsToast({ count: 2, unlocked: 3 }), '2 steps done · 3 up next');
  assert.equal(completedStepsToast({ count: 1200, unlocked: 3400 }), '1,200 steps done · 3,400 up next');
});

test('copy — the roadmap sheet gives exact progress in state order', () => {
  assert.equal(exactProgress({ done: 0, upNext: 0, locked: 0 }), '0 done · 0 up next · 0 locked');
  assert.equal(exactProgress({ done: 1, upNext: 2, locked: 3 }), '1 done · 2 up next · 3 locked');
  assert.equal(exactProgress({ done: 1200, upNext: 3400, locked: 5600 }), '1,200 done · 3,400 up next · 5,600 locked');
});


test('completion copy accepts a count without treating step ids as display names', () => {
  assert.deepEqual([0, 1, 2].map((unlockedCount) => completedToast({ step: 'Rig the boat yourself', unlockedCount })), [
    'Rig the boat yourself done',
    'Rig the boat yourself done · 1 up next',
    'Rig the boat yourself done · 2 up next',
  ]);
  assert.equal(completedToast({ step: 'Rig the boat yourself', unlocked: ['Practice tacking'] }),
    'Rig the boat yourself done · Practice tacking up next');
});

test('copy — approved capacity and plural refusal wording preserves singular copy and full counts', async () => {
  const { REFUSED_CAPACITY, refusedSyncBody, discardChanges } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(REFUSED_CAPACITY, { title: 'This roadmap is at its limit.', body: 'This change can’t sync.' });
  assert.deepEqual([1, 3, 1200].map((count) => ({ body: refusedSyncBody({ count }), discard: discardChanges({ count }) })), [
    { body: 'Couldn’t sync this change.', discard: 'Discard change' },
    { body: 'Couldn’t sync 3 changes.', discard: 'Discard 3 changes' },
    { body: 'Couldn’t sync 1,200 changes.', discard: 'Discard 1,200 changes' },
  ]);
});

test('copy — roadmap headings and matches use full counts', async () => {
  const { roadmapsHeading, roadmapMatches } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual([0, 1, 1200].map((count) => roadmapsHeading({ count })), [
    'Your roadmaps · 0', 'Your roadmaps · 1', 'Your roadmaps · 1,200',
  ]);
  assert.deepEqual([
    roadmapMatches({ shown: 0, total: 8 }),
    roadmapMatches({ shown: 1, total: 1 }),
    roadmapMatches({ shown: 1200, total: 3400 }),
  ], ['0 of 8 roadmaps', '1 of 1 roadmaps', '1,200 of 3,400 roadmaps']);
});

test('copy — demo bylines match the wave 8 contract', async () => {
  const { DEMO_BYLINE } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(DEMO_BYLINE, { wide: 'Windmill sample', phone: 'Sample' });
});

test('copy — Ask AI placeholders match each wave 8 presentation', async () => {
  const { ASK_AI_PLACEHOLDER } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(ASK_AI_PLACEHOLDER, {
    phone: 'What should change?',
    wide: 'Tell the tree what to change…',
    empty: 'What do you want to learn or build?',
  });
});

test('copy — the Graph handoff opens the step', async () => {
  const { OPEN_STEP } = await import('../../../src/products/roadmap/copy.js');
  assert.equal(OPEN_STEP, 'Open step');
});

test('copy — Activity has its approved heading and shipped empty sentence', async () => {
  const { ACTIVITY } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual(ACTIVITY, {
    heading: 'Activity',
    empty: 'No activity yet — changes you make will appear here.',
  });
});

test('deleteCostLine — a leaf states only the removal, no branches resplice', () => {
  assert.equal(deleteCostLine(0), 'Removes this step');
  assert.equal(deleteCostLine(-1), 'Removes this step');
});

test('deleteCostLine — one child reads in the singular', () => {
  assert.equal(deleteCostLine(1), 'Removes this step · 1 branch resplices');
});

test('deleteCostLine — many children read in the plural', () => {
  assert.equal(deleteCostLine(2), 'Removes this step · 2 branches resplice');
  assert.equal(deleteCostLine(7), 'Removes this step · 7 branches resplice');
});

test('Board and Graph share the shipped Recolor spelling for every action label', async () => {
  const { RECOLOR } = await import('../../../src/products/roadmap/copy.js');
  assert.deepEqual({ button: BULK.recolor, kind: RECOLOR.kind('Learn'), steps: RECOLOR.steps, selection: RECOLOR.selection('Learn') }, {
    button: LABELS.recolor, kind: `${LABELS.recolor} Learn`, steps: `${LABELS.recolor} selected steps`, selection: `${LABELS.recolor} selection to Learn`,
  });
});

test('unavailable Graph says its device requirement without an action promise', () => {
  assert.equal(GRAPH_UNAVAILABLE, 'Graph needs WebGL2, which this browser doesn’t support.');
});

const openedTrees = () => {
  const read = (state, done, total, loop = false) => Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state, done, total, loop });
  return {
    open: read('open', 3, 8), complete: read('complete', 12, 12), empty: read('open', 0, 0), loop: read('open', 3, 8, true),
    missing: Opening.fromWire({ treeId: 't_gone', missing: true }), unread: Opening.unread('t_sail'),
  };
};
const eachTree = (say) => Object.fromEntries(Object.entries(openedTrees()).map(([face, opening]) => [face, say(opening)]));

test('a card’s pill and the phone Graph’s bar say done of total or the one thing in the way, after the tree’s title or the step’s column', () => {
  assert.deepEqual(eachTree((opening) => treeLine(opening)), {
    open: '3 of 8', complete: '12 of 12', empty: 'No steps', loop: 'Loops back', missing: 'Not found', unread: null,
  });
  assert.deepEqual(eachTree((opening) => treeLine(opening, 'Coast trip')), {
    open: 'Coast trip · 3 of 8', complete: 'Coast trip · 12 of 12', empty: 'Coast trip · No steps', loop: 'Coast trip · Loops back',
    missing: 'Coast trip · Not found', unread: null,
  });
});

test('the step’s Tree row names the tree and how far it is, a loop by the roadmap it leads back to', () => {
  assert.deepEqual(eachTree((opening) => [treeTitle(opening), treeState(opening, 'My year')]), {
    open: ['Learn to sail', '3 of 8 done'], complete: ['Learn to sail', '12 of 12 done'], empty: ['Learn to sail', 'No steps'],
    loop: ['Learn to sail', '3 of 8 done · opens My year back'], missing: ['Tree not found', 'Nothing at the other end'], unread: ['', null],
  });
});

test('a tree’s progress reads the same on the step’s row and in the tree picker, and a tree with no steps says so', () => {
  assert.deepEqual([{ done: 3, total: 8 }, { done: 12, total: 12 }, { done: 0, total: 5 }, { done: 0, total: 0 }, { done: 1200, total: 3400 }].map(treeProgress),
    ['3 of 8 done', '12 of 12 done', '0 of 5 done', 'No steps', '1,200 of 3,400 done']);
});

test('the toast of an attach, a detach and a write that could not be made', () => {
  assert.deepEqual(TREE_TOAST, {
    attached: 'Tree attached', detached: 'Tree detached', detachedMarkBack: 'Tree detached · your mark is back',
    failed: 'Couldn’t change the tree. Try again.',
  });
});

test('the Tree row that goes in is named by what its press does, then what it shows', () => {
  const { open, complete, empty, loop } = openedTrees();
  assert.deepEqual([open, complete, empty, loop].map((opening) => openTreeStated(opening, 'My year')), [
    'Open Learn to sail · 3 of 8 done', 'Open Learn to sail · 12 of 12 done', 'Open Learn to sail · No steps',
    'Open Learn to sail · 3 of 8 done · opens My year back',
  ]);
});

test('where Complete sat: what completes the step, by its column and what its tree has come to', () => {
  assert.deepEqual(eachTree((opening) => ['upNext', 'locked', 'done'].map((column) => treeBand(opening, { column, toGo: 2 }))), {
    open: ['Completes with its tree', '2 to go', 'Completes with its tree'],
    complete: ['Completed by its tree', 'Completed by its tree', 'Completed by its tree'],
    empty: ['Completes with its tree', '2 to go', 'Completes with its tree'],
    loop: ['Won’t complete by itself', 'Won’t complete by itself', 'Won’t complete by itself'],
    missing: ['Can’t complete yet', 'Can’t complete yet', null],
    unread: [null, null, null],
  });
});
