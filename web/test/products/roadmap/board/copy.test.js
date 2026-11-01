import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_WORDS,
  COLUMN_TITLES,
  SORT_LABELS,
  SORT_MENU,
  LABELS,
  LINK_COPIED,
  EMPTY_ROADMAP,
  LOAD_ERROR,
  SAVE_FAILURE,
  DISCARD_DRAFT,
  FILTERED_EMPTY,
  SYNC_STATUS,
  REFUSED_SYNC,
  ANONYMOUS_OWNER,
  LAPSED_SESSION,
  formatCount,
  stepCount,
  needsLine,
  unlocksLine,
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
  notDone,
  roadmapComplete,
  searchEmpty,
  emptyColumn,
  removeChip,
} from '../../../../src/products/roadmap/board/copy.js';

test('copy — one word per state, one title per column, one label per sort', () => {
  assert.deepEqual(STATE_WORDS, { locked: 'locked', upNext: 'up next', done: 'done' });
  assert.deepEqual(COLUMN_TITLES, { locked: 'Locked', upNext: 'Up next', done: 'Done' });
  assert.deepEqual(SORT_LABELS, { roadmap: 'Roadmap order', newest: 'Created · newest', oldest: 'Created · oldest' });
  assert.deepEqual(LABELS, {
    columns: 'Columns',
    findStep: 'Find a step',
    filterByKind: 'Filter by kind',
    allKinds: 'All',
    newStep: 'New step',
    recolor: 'Recolor',
    undo: 'Undo',
    show: 'Show',
    allSubtasksDone: 'All subtasks done · Complete step',
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
  assert.deepEqual([0, 1, 2, 3200].map(stepCount), ['0 steps', '1 step', '2 steps', '3,200 steps']);
});

test('copy — card reasons and the locked status read the structured reasons', () => {
  assert.equal(needsLine({ need: 'Read the wind', extra: 0, toGo: 1 }), 'Needs Read the wind · 1 to go');
  assert.equal(needsLine({ need: 'Sail a triangle', extra: 1, toGo: 4 }), 'Needs Sail a triangle +1 · 4 to go');
  assert.equal(unlocksLine({ first: 'Leave the dock', extra: 0 }), 'Unlocks Leave the dock');
  assert.equal(unlocksLine({ first: 'Tie a bowline', extra: 1 }), 'Unlocks Tie a bowline +1');
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
  assert.equal(notDone({ step: 'Read the wind' }), 'Read the wind isn’t done');
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
  assert.deepEqual(searchEmpty({ query: ' astronomy ' }), {
    title: 'No steps match “astronomy”', clear: 'Clear search', create: 'New step “astronomy”',
  });
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
});

test('copy — the step page and modal', async () => {
  const { STEP_DETAIL, prerequisitesTally, backTo } = await import('../../../../src/products/roadmap/board/copy.js');
  assert.deepEqual(STEP_DETAIL, {
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
    subtasks: 'Subtasks',
    addSubtask: 'Add subtask',
    subtaskOffer: { body: 'All subtasks done', action: 'Complete step' },
    unnamed: 'Unnamed step',
  });
  assert.deepEqual([prerequisitesTally({ done: 1, total: 2 }), prerequisitesTally({ done: 1200, total: 3200 }), backTo({ screen: 'Learn to sail' })],
    ['1 / 2', '1,200 / 3,200', 'Back to Learn to sail']);
});
