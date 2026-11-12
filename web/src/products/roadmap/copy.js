// The room's shared words and the sentences it builds from counts, read from the roadmap catalog. Step titles arrive as plain strings.

import { COACHED_CHILDREN } from './demo/demoStage.js';
import { t } from './i18n/index.js';

export const STATE_WORDS = { locked: t('roadmap.state.locked'), upNext: t('roadmap.state.upNext'), done: t('roadmap.state.done') };
export const COLUMN_TITLES = { locked: t('roadmap.column.locked'), upNext: t('roadmap.column.upNext'), done: t('roadmap.column.done') };
export const SORT_LABELS = { roadmap: t('roadmap.sortLabel.roadmap'), newest: t('roadmap.sortLabel.newest'), oldest: t('roadmap.sortLabel.oldest') };
export const SHORTCUTS_TITLE = t('roadmap.shortcuts.boardTitle');
export const SORT_MENU = {
  title: t('roadmap.sortMenu.title'),
  created: t('roadmap.sortMenu.created'),
  options: { roadmap: t('roadmap.sortMenu.roadmap'), newest: t('roadmap.sortMenu.newest'), oldest: t('roadmap.sortMenu.oldest') },
  roadmapDetail: t('roadmap.sortMenu.roadmapDetail'),
};

export const LABELS = {
  columns: t('roadmap.label.columns'),
  findStep: t('roadmap.label.findStep'),
  filterByKind: t('roadmap.label.filterByKind'),
  manageKinds: t('roadmap.label.manageKinds'),
  allKinds: t('roadmap.label.allKinds'),
  newStep: t('roadmap.label.newStep'),
  recolor: t('roadmap.label.recolor'),
  undo: t('roadmap.common.undo'),
  show: t('roadmap.label.show'),
  sort: t('roadmap.label.sort'),
  branch: t('roadmap.label.branch'),
  clearBranch: t('roadmap.label.clearBranch'),
  clearSearch: t('roadmap.label.clearSearch'),
  close: t('roadmap.common.close'),
};

export const VIEW_SWITCH = { group: t('roadmap.viewSwitch.group'), board: t('roadmap.viewSwitch.board'), graph: t('roadmap.viewSwitch.graph') };
export const ROADMAP_VERBS = {
  askAI: t('roadmap.verb.askAI'),
  share: t('roadmap.verb.share'),
  shareRoadmap: t('roadmap.verb.shareRoadmap'),
  more: t('roadmap.common.more'),
  export: t('roadmap.verb.export'),
  settings: t('roadmap.verb.settings'),
  keyboardShortcuts: t('roadmap.verb.keyboardShortcuts'),
  fork: t('roadmap.verb.fork'),
  activity: t('roadmap.verb.activity'),
};
export const ROADMAP_SHEET = {
  title: t('roadmap.sheet.title'),
  yourRoadmaps: t('roadmap.sheet.yourRoadmaps'),
  newRoadmap: t('roadmap.sheet.newRoadmap'),
  plantedInPublic: t('roadmap.sheet.plantedInPublic'),
  findRoadmap: t('roadmap.sheet.findRoadmap'),
};

// The guide's words the row, the roadmap sheet, the modal and the phone editor all say.
export const GUIDE = {
  title: t('roadmap.guide.title'),
  add: t('roadmap.guide.add'),
  authorsNote: t('roadmap.guide.authorsNote'),
  placeholder: t('roadmap.guide.placeholder'),
  disclosure: t('roadmap.guide.disclosure'),
  deviceDisclosure: t('roadmap.guide.deviceDisclosure'),
};
export const guideLabel = ({ owner, excerpt }) => (owner ? t('roadmap.guide.label', { excerpt }) : t('roadmap.guide.noteLabel', { excerpt }));
export const guideCounter = (draft) => (draft.over > 0
  ? t('roadmap.guide.over', { count: formatCount(draft.over) })
  : t('roadmap.guide.left', { count: formatCount(draft.left) }));

export const LINK_COPIED = t('roadmap.share.linkCopied');
export const EMPTY_ROADMAP = { title: t('roadmap.emptyRoadmap.title'), body: t('roadmap.emptyRoadmap.body'), action: t('roadmap.emptyRoadmap.action') };
export const LOAD_ERROR = {
  title: t('roadmap.loadError.title'),
  body: t('roadmap.loadError.body'),
  action: t('roadmap.common.tryAgain'),
};
export const GRAPH_LOAD = { planting: t('roadmap.graphLoad.planting'), home: t('roadmap.graphLoad.home') };
export const SAVE_FAILURE = { body: t('roadmap.saveFailure.body'), retry: t('roadmap.common.retry'), keepEditing: t('roadmap.saveFailure.keepEditing') };
export const DISCARD_DRAFT = {
  title: t('roadmap.discardDraft.title'),
  body: t('roadmap.discardDraft.body'),
  keepEditing: t('roadmap.discardDraft.keepEditing'),
  discard: t('roadmap.discardDraft.discard'),
};
export const FILTERED_EMPTY = { title: t('roadmap.filteredEmpty.title'), action: t('roadmap.filteredEmpty.action') };
export const SYNC_STATUS = { saving: t('roadmap.sync.saving'), saved: t('roadmap.sync.saved'), offline: t('roadmap.sync.offline') };
export const SYNC_OFFLINE_SHORT = t('roadmap.sync.offlineShort');
export const REFUSED_SYNC = { body: t('roadmap.refusedSync.body'), retry: t('roadmap.common.retry'), discard: t('roadmap.refusedSync.discard') };
export const ANONYMOUS_OWNER = t('roadmap.sync.anonymousOwner');
export const LAPSED_SESSION = t('roadmap.sync.lapsedSession');
export const DEVICE_REFUSED = { title: t('roadmap.deviceRefused.title'), body: t('roadmap.deviceRefused.body') };
export const FORK_OFFER = t('roadmap.fork.offer');
export const DELETE_CONFIRM = { cancel: t('roadmap.common.cancel'), delete: t('roadmap.common.delete') };
export const COMPOSER = {
  title: t('roadmap.composer.title'),
  cancel: t('roadmap.common.cancel'),
  name: t('roadmap.composer.name'),
  namePlaceholder: t('roadmap.composer.namePlaceholder'),
  nameRequired: t('roadmap.composer.nameRequired'),
  description: t('roadmap.composer.description'),
  descriptionPlaceholder: t('roadmap.composer.descriptionPlaceholder'),
  kind: t('roadmap.composer.kind'),
  prerequisites: t('roadmap.composer.prerequisites'),
  none: t('roadmap.composer.none'),
  create: t('roadmap.composer.create'),
};
export const EDIT_STEP = { title: t('roadmap.editStep.title'), save: t('roadmap.common.save') };
export const PICKER = {
  title: t('roadmap.picker.title'),
  allSteps: t('roadmap.picker.allSteps'),
  cantBe: t('roadmap.picker.cantBe'),
  apply: t('roadmap.common.apply'),
  cancel: t('roadmap.common.cancel'),
  selectionKept: t('roadmap.picker.selectionKept'),
  clearSearch: t('roadmap.picker.clearSearch'),
  startingStep: t('roadmap.picker.startingStep'),
  thisStep: t('roadmap.picker.thisStep'),
  comesAfter: t('roadmap.picker.comesAfter'),
  nowComesAfter: t('roadmap.picker.nowComesAfter'),
};
export const WORKSPACE = {
  subtask: t('roadmap.workspace.subtask'),
  subtasks: t('roadmap.workspace.subtasks'),
  addSubtask: t('roadmap.workspace.addSubtask'),
  note: t('roadmap.workspace.note'),
  edit: t('roadmap.workspace.edit'),
  personalLinks: t('roadmap.workspace.personalLinks'),
  addLink: t('roadmap.workspace.addLink'),
  removeLink: t('roadmap.workspace.removeLink'),
  removeSubtask: t('roadmap.workspace.removeSubtask'),
};
export const NOTE_EDITOR = {
  title: t('roadmap.noteEditor.title'),
  cancel: t('roadmap.common.cancel'),
  save: t('roadmap.common.save'),
  bold: t('roadmap.noteEditor.bold'),
  italic: t('roadmap.noteEditor.italic'),
  link: t('roadmap.noteEditor.link'),
  list: t('roadmap.noteEditor.list'),
  text: t('roadmap.noteEditor.text'),
  url: t('roadmap.noteEditor.url'),
  urlPlaceholder: t('roadmap.noteEditor.urlPlaceholder'),
  apply: t('roadmap.common.apply'),
};
export const BULK = { region: t('roadmap.bulk.region'), done: t('roadmap.bulk.done'), recolor: LABELS.recolor };
export const RECOLOR = {
  steps: t('roadmap.recolor.steps'),
  kind: (name) => t('roadmap.recolor.kind', { name }),
  selection: (name) => t('roadmap.recolor.selection', { name }),
};

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

export function nextChip({ count }) {
  return t('roadmap.board.nextChip', { count: formatCount(count) });
}

export function upNextCount({ count }) {
  return t('roadmap.board.upNextCount', { count: formatCount(count) });
}

export function unlocksWhen({ step }) {
  return t('roadmap.step.unlocksWhen', { step });
}

export function selectingAnnouncement({ count }) {
  return t('roadmap.bulk.selecting', { count: formatCount(count) });
}

export function selectedCount({ count }) {
  return t('roadmap.bulk.selected', { count: formatCount(count) });
}

// A Locked card names what it needs, an Up next card what it opens; Done and a card that opens nothing say neither.
export function reasonLine({ needs, unlocks }) {
  if (needs && needs.extra > 0) {
    return t('roadmap.card.needsMore', { step: needs.need.label, extra: formatCount(needs.extra), toGo: formatCount(needs.toGo) });
  }
  if (needs) return t('roadmap.card.needs', { step: needs.need.label, toGo: formatCount(needs.toGo) });
  if (unlocks && unlocks.extra > 0) return t('roadmap.card.unlocksMore', { step: unlocks.first.label, extra: formatCount(unlocks.extra) });
  if (unlocks) return t('roadmap.card.unlocks', { step: unlocks.first.label });
  return null;
}

export function lockedStatus({ toGo }) {
  return t('roadmap.card.lockedStatus', { toGo: formatCount(toGo) });
}

export function columnHeadingLabel({ column, count }) {
  return t('roadmap.board.columnHeading', { column: COLUMN_TITLES[column], count, shown: formatCount(count) });
}

export function progressFigure({ done, total, compact = false }) {
  return `${formatCount(done, { compact })}/${formatCount(total, { compact })}`;
}

export function progressLabel({ done, total }) {
  return t('roadmap.progress.label', { done: formatCount(done), total, totalShown: formatCount(total) });
}

export function exactProgress({ done, upNext, locked }) {
  return t('roadmap.progress.exact', { done: formatCount(done), upNext: formatCount(upNext), locked: formatCount(locked) });
}

export function showColumn({ column }) {
  return t('roadmap.board.showColumn', { column });
}

export function showAllDone({ total }) {
  return t('roadmap.board.showAllDone', { total: formatCount(total) });
}

export function branchChip({ step }) {
  return t('roadmap.board.branchChip', { step });
}

export function completedToast({ step, unlocked = [], unlockedCount = unlocked.length }) {
  if (unlockedCount === 0) return t('roadmap.toast.completed', { step });
  if (unlockedCount === 1 && unlocked.length === 1) return t('roadmap.toast.completedOpening', { step, next: unlocked[0] });
  return t('roadmap.toast.completedOpeningMany', { step, count: formatCount(unlockedCount) });
}

export const DEMO_COPY = {
  coachSentence: t('roadmap.demo.coachSentence'),
  coachButton: t('roadmap.demo.coachButton'),
  unlockToast: completedToast({ step: 'Rig the boat yourself', unlockedCount: COACHED_CHILDREN.length }),
};

export function completedStepsToast({ count, unlocked }) {
  if (unlocked > 0) return t('roadmap.toast.completedStepsOpening', { count, shown: formatCount(count), unlocked: formatCount(unlocked) });
  return t('roadmap.toast.completedSteps', { count, shown: formatCount(count) });
}

export function completedOutcome({ unlocked }) {
  if (unlocked.length === 0) return null;
  if (unlocked.length === 1) return t('roadmap.step.completedOutcome', { next: unlocked[0] });
  return t('roadmap.step.completedOutcomeMany', { count: unlocked.length, shown: formatCount(unlocked.length) });
}

export function resetOutcome({ relocked }) {
  if (relocked === 0) return null;
  return t('roadmap.step.resetOutcome', { count: relocked, shown: formatCount(relocked) });
}

export function resetPreview({ relocked }) {
  if (relocked === 0) return null;
  return t('roadmap.step.resetPreview', { count: relocked, shown: formatCount(relocked) });
}

export function createdToast({ step, column, filterCleared = false }) {
  if (filterCleared) return t('roadmap.toast.createdFilterCleared', { step });
  return t('roadmap.toast.created', { step, column: COLUMN_TITLES[column] });
}

// A fresh plant's arrival ends on this line; a quest names itself.
export function plantedToast({ quest = false, count, done = 0 }) {
  const planted = quest ? 'quest' : 'roadmap';
  if (done > 0) return t('roadmap.toast.plantedSomeDone', { planted, count, shown: formatCount(count), done: formatCount(done) });
  return t('roadmap.toast.planted', { planted, count, shown: formatCount(count) });
}

export function welcomeBackToast({ count }) {
  return t('roadmap.toast.welcomeBack', { count, shown: formatCount(count) });
}

export function forkedToast({ count }) {
  return t('roadmap.toast.forked', { count, shown: formatCount(count) });
}

export function deletedToast({ step }) {
  return t('roadmap.toast.deleted', { step });
}

export function deleteFailedToast({ step, count = 1 }) {
  if (count > 1) return t('roadmap.toast.deleteFailedSteps', { count, shown: formatCount(count) });
  return t('roadmap.toast.deleteFailed', { step: step || STEP_DETAIL.unnamed });
}

export function recoloredToast({ count }) {
  return t('roadmap.toast.recolored', { count, shown: formatCount(count) });
}

export function deletedStepsToast({ count }) {
  return t('roadmap.toast.deletedSteps', { count, shown: formatCount(count) });
}

export const GRAPH_TOAST = {
  stepDeleted: t('roadmap.graphToast.stepDeleted'),
  stepAdded: t('roadmap.graphToast.stepAdded'),
  renamed: t('roadmap.graphToast.renamed'),
  recolored: t('roadmap.graphToast.recolored'),
  linked: t('roadmap.graphToast.linked'),
  linkRemoved: t('roadmap.graphToast.linkRemoved'),
  restore: t('roadmap.graphToast.restore'),
  undrawnEdit: t('roadmap.graphToast.undrawnEdit'),
};

export const TEND_TOAST = { why: t('roadmap.tendToast.why'), hide: t('roadmap.tendToast.hide'), reverted: t('roadmap.tendToast.reverted') };

export function deletedSelectionToast({ steps, links }) {
  if (steps > 0 && links > 0) {
    return t('roadmap.toast.deletedStepsAndLinks', { steps, stepsShown: formatCount(steps), links, linksShown: formatCount(links) });
  }
  if (steps > 0) return t('roadmap.toast.deletedSteps', { count: steps, shown: formatCount(steps) });
  return t('roadmap.toast.deletedLinks', { count: links, shown: formatCount(links) });
}

export function graftedToast({ count, under = null }) {
  if (under) return t('roadmap.toast.graftedUnder', { count, shown: formatCount(count), under });
  return t('roadmap.toast.grafted', { count, shown: formatCount(count) });
}

export function keptStepsToast({ count }) {
  return t('roadmap.toast.keptSteps', { count, shown: formatCount(count) });
}

export function cycleToast({ ring }) {
  return t('roadmap.toast.cycle', { ring: ring.join(' → ') });
}

export function deleteStepsAction({ count }) {
  return t('roadmap.bulk.deleteSteps', { count, shown: formatCount(count) });
}

export function deleteCostLine(childCount) {
  if (childCount <= 0) return t('roadmap.step.deleteCost');
  return t('roadmap.step.deleteCostResplice', { count: childCount });
}

export function deleteConfirm({ step }) {
  return t('roadmap.deleteConfirm.question', { step });
}

export function completeStepAction({ step }) {
  return t('roadmap.step.completeAction', { step });
}

export function placementPreview({ prerequisites, unmet }) {
  if (prerequisites.length === 0) return { column: 'upNext', body: t('roadmap.composer.placementFree') };
  if (unmet.length === 0) return { column: 'upNext', body: t('roadmap.composer.placementMet') };
  if (unmet.length === 1) return { column: 'locked', body: t('roadmap.composer.placementUnmetOne', { step: unmet[0] }) };
  if (unmet.length === 2) return { column: 'locked', body: t('roadmap.composer.placementUnmetTwo', { first: unmet[0], second: unmet[1] }) };
  return { column: 'locked', body: t('roadmap.composer.placementUnmetMany', { first: unmet[0], more: formatCount(unmet.length - 1) }) };
}

export function prerequisiteNames(labels) {
  return labels.join(', ');
}

export function pickerFor({ step, total }) {
  const name = step.trim();
  if (!name) return null;
  if (total == null) return t('roadmap.picker.for', { step: name });
  return t('roadmap.picker.forInRoadmap', { step: name, total, totalShown: formatCount(total) });
}

export function matchCount({ shown, count, total, band }) {
  const inRoadmap = band === 'desktop' && total != null;
  if (shown < count && inRoadmap) {
    return t('roadmap.picker.pagedMatchesIn', { visible: formatCount(shown), count, shown: formatCount(count), total, totalShown: formatCount(total) });
  }
  if (shown < count) return t('roadmap.picker.pagedMatches', { visible: formatCount(shown), count, shown: formatCount(count) });
  if (inRoadmap) return t('roadmap.picker.matchesIn', { count, shown: formatCount(count), total, totalShown: formatCount(total) });
  return t('roadmap.picker.matches', { count, shown: formatCount(count) });
}

export function afterStep({ step }) {
  return t('roadmap.picker.afterStep', { step });
}

export function leftSelection({ step }) {
  return t('roadmap.picker.leftSelection', { step });
}

export function noStepsMatch({ query }) {
  return t('roadmap.filteredEmpty.noStepsMatch', { query: query.trim() });
}

export function showMore({ count }) {
  return t('roadmap.picker.showMore', { count: formatCount(count) });
}

export function checkedToast({ item }) {
  return t('roadmap.toast.checked', { item });
}

export function roadmapComplete({ total }) {
  return {
    title: t('roadmap.complete.title', { total, totalShown: formatCount(total) }),
    body: t('roadmap.complete.body'),
    share: t('roadmap.complete.share'),
  };
}

// What an emptied column says, by the way out it names: the search, the kinds or both.
export function emptyColumn({ recovery, search }) {
  if (recovery === 'kinds') return { title: FILTERED_EMPTY.title, action: FILTERED_EMPTY.action };
  return { title: noStepsMatch({ query: search }), action: recovery === 'both' ? t('roadmap.filteredEmpty.clearBoth') : LABELS.clearSearch };
}

export function removeChip({ label }) {
  return t('roadmap.board.removeChip', { label });
}

export function sortButtonLabel({ sort }) {
  return t('roadmap.sortMenu.button', { sort: SORT_MENU.options[sort] });
}

// The step page and modal.
export const STEP_DETAIL = {
  select: t('roadmap.step.select'),
  sections: { overview: t('roadmap.step.overview'), workspace: t('roadmap.step.workspace'), history: t('roadmap.step.history') },
  stepLinks: t('roadmap.step.stepLinks'),
  prerequisites: t('roadmap.step.prerequisites'),
  unlocks: t('roadmap.step.unlocks'),
  complete: t('roadmap.step.complete'),
  reset: t('roadmap.step.reset'),
  close: t('roadmap.common.close'),
  more: t('roadmap.common.more'),
  back: t('roadmap.common.back'),
  copyLink: t('roadmap.step.copyLink'),
  openInGraph: t('roadmap.step.openInGraph'),
  deleteStep: t('roadmap.step.deleteStep'),
  editStep: t('roadmap.step.editStep'),
  editNote: t('roadmap.step.editNote'),
  viewBranch: t('roadmap.step.viewBranch'),
  subtasks: t('roadmap.step.subtasks'),
  addSubtask: t('roadmap.step.addSubtask'),
  subtaskOffer: { body: t('roadmap.step.subtaskOfferBody'), action: t('roadmap.step.subtaskOfferAction') },
  unnamed: t('roadmap.step.unnamed'),
};

// The tree a step opens, as its surfaces say it: by what that tree has come to (Opening.face).
export const TREE = { heading: t('roadmap.tree.heading'), open: t('roadmap.tree.open'), openShort: t('roadmap.tree.openShort') };

// The card's pill and the phone Graph's bar: done of total, or the one thing in the way, after a lead where there is
// one to say: the tree's title on a pill, the step's column on the bar. Null where nothing was read of the tree.
export function treeLine(opening, lead = null) {
  const done = formatCount(opening.done);
  const total = formatCount(opening.total);
  const count = () => (lead ? t('roadmap.tree.line.countLed', { lead, done, total }) : t('roadmap.tree.line.count', { done, total }));
  const lines = {
    open: count,
    complete: count,
    empty: () => (lead ? t('roadmap.tree.line.emptyLed', { lead }) : t('roadmap.tree.line.empty')),
    loop: () => (lead ? t('roadmap.tree.line.loopLed', { lead }) : t('roadmap.tree.line.loop')),
    missing: () => (lead ? t('roadmap.tree.line.missingLed', { lead }) : t('roadmap.tree.line.missing')),
    unread: () => null,
  };
  return lines[opening.face]();
}

// The step's Tree row and the Graph's dock: how far the tree is, in full. `roadmap` is the title of the one being read.
export function treeState(opening, roadmap) {
  const done = formatCount(opening.done);
  const total = formatCount(opening.total);
  const states = {
    open: () => t('roadmap.tree.state.done', { done, total }),
    complete: () => t('roadmap.tree.state.done', { done, total }),
    empty: () => t('roadmap.tree.line.empty'),
    loop: () => t('roadmap.tree.state.loop', { done, total, roadmap }),
    missing: () => t('roadmap.tree.state.missing'),
    unread: () => null,
  };
  return states[opening.face]();
}

export function treeTitle(opening) {
  return opening.dangling ? t('roadmap.tree.state.missingTitle') : opening.title;
}

// What stands where Complete sat, and on the toast a C on the card raises: null where nothing was read of the tree.
export function treeBand(opening, { column, toGo = 0 }) {
  const workable = () => (column === 'locked' ? t('roadmap.tree.band.toGo', { toGo: formatCount(toGo) }) : t('roadmap.tree.band.completes'));
  const words = {
    open: workable,
    empty: workable,
    complete: () => t('roadmap.tree.band.completed'),
    loop: () => t('roadmap.tree.band.loop'),
    missing: () => t('roadmap.tree.band.missing'),
    unread: () => null,
  };
  return words[opening.face]();
}

export function openTreeAction({ step }) {
  return t('roadmap.tree.openAction', { step });
}

export function prerequisitesTally({ done, total }) {
  return `${formatCount(done)} / ${formatCount(total)}`;
}

export function subtaskTally({ done, total }) {
  return t('roadmap.step.subtaskTally', { done, total });
}

export function backTo({ screen }) {
  return t('roadmap.step.backTo', { screen });
}

export function draftLine({ step }) {
  return t('roadmap.composer.draftLine', { step });
}

export const WORKSPACE_EMPTY = { body: t('roadmap.workspace.emptyBody'), addNote: t('roadmap.workspace.addNote') };
export const NEW_LINK = { title: t('roadmap.workspace.newLink') };
export const HISTORY_EMPTY = t('roadmap.step.historyEmpty');

export const REFUSED_CAPACITY = { title: t('roadmap.refusedCapacity.title'), body: t('roadmap.refusedCapacity.body') };

export function refusedSyncBody({ count }) {
  if (count > 1) return t('roadmap.refusedSync.bodyMany', { count: formatCount(count) });
  return REFUSED_SYNC.body;
}

export function discardChanges({ count }) {
  if (count > 1) return t('roadmap.refusedSync.discardMany', { count: formatCount(count) });
  return REFUSED_SYNC.discard;
}

export function roadmapsHeading({ count }) {
  return t('roadmap.sheet.yourRoadmapsCount', { count: formatCount(count) });
}

export function roadmapMatches({ shown, total }) {
  return t('roadmap.sheet.matches', { shown: formatCount(shown), total: formatCount(total) });
}

export const DEMO_BYLINE = { wide: t('roadmap.demo.bylineWide'), phone: t('roadmap.demo.bylinePhone') };
export const ASK_AI_PLACEHOLDER = {
  phone: t('roadmap.askAI.placeholderPhone'),
  wide: t('roadmap.askAI.placeholderWide'),
  empty: t('roadmap.askAI.placeholderEmpty'),
};
export const OPEN_STEP = t('roadmap.graph.openStep');
export const ACTIVITY = {
  heading: t('roadmap.activity.heading'),
  empty: t('roadmap.activity.empty'),
};

export const GRAPH_UNAVAILABLE = t('roadmap.viewSwitch.graphUnavailable');
