// Three derived columns; filter, search and branch narrow the cards, never the states or progress.

import { DEFAULT_NODE_COLOR } from '../theme.js';
import { UnlockRules, unmetPrerequisitesOf, owedCounts, unlocksOf } from '../model/UnlockRules.js';

export const BOARD_SORTS = ['roadmap', 'newest', 'oldest'];
export const DONE_RECENT_LIMIT = 12;

const COLUMN_OF_STATE = { locked: 'locked', available: 'upNext', complete: 'done' };

class BoardCard {
  constructor(tree, states, owed, step) {
    const state = states.get(step.id);
    const opens = state === 'complete' ? [] : unlocksOf(tree, states, step.id);
    const unmet = state === 'locked' ? unmetPrerequisitesOf(tree, states, step.id) : [];

    this.step = step;
    this.column = COLUMN_OF_STATE[state];
    this.unlockCount = opens.length;
    this.needs = state === 'locked'
      ? { need: unmet[0], extra: unmet.length - 1, toGo: owed.get(step.id) }
      : null;
    this.unlocks = state === 'available' && opens.length > 0
      ? { first: opens[0], extra: opens.length - 1 }
      : null;
  }

  get id() { return this.step.id; }
  get toGo() { return this.needs?.toGo ?? 0; }
}

class BoardColumn {
  constructor(name, cards) {
    this.name = name;
    this.cards = cards;
  }

  get count() { return this.cards.length; }
}

// What narrows and orders the Board: the sort, the kinds on (OR), the search text and the branch in scope. Every change
// returns a new query. Clearing filters takes the kinds and the search and leaves the branch, which clears on its own.
export class BoardQuery {
  constructor({ sort = 'roadmap', kinds = [], search = '', branch = null } = {}) {
    if (!BOARD_SORTS.includes(sort)) throw new Error(`Unknown board sort "${sort}"`);
    this.sort = sort;
    this.kinds = kinds;
    this.search = search;
    this.branch = branch;
    Object.freeze(this);
  }

  get searching() { return this.search.trim() !== ''; }

  // The way out an emptied column names: the search, the kinds, both, or none while only the branch narrows.
  get recovery() {
    const kinds = this.kinds.length > 0;
    if (this.searching && kinds) return 'both';
    if (this.searching) return 'search';
    if (kinds) return 'kinds';
    return null;
  }

  with(change) {
    return new BoardQuery({ ...this, ...change });
  }

  sortedBy(sort) { return this.with({ sort }); }
  searchingFor(search) { return this.with({ search }); }
  inBranch(branch) { return this.with({ branch }); }

  toggledKind(hue) {
    return this.with({ kinds: this.kinds.includes(hue) ? this.kinds.filter((kind) => kind !== hue) : [...this.kinds, hue] });
  }

  // `what` is 'search', 'kinds', 'both', 'sort' or 'branch'.
  without(what) {
    if (what === 'search') return this.with({ search: '' });
    if (what === 'kinds') return this.with({ kinds: [] });
    if (what === 'both') return this.with({ search: '', kinds: [] });
    if (what === 'sort') return this.with({ sort: 'roadmap' });
    if (what === 'branch') return this.with({ branch: null });
    throw new Error(`Unknown board query part "${what}"`);
  }

  // Kinds narrow only among the hues a filter offers, so a kind with no control left on screen never hides a step.
  among(hues) {
    const kinds = this.kinds.filter((kind) => hues.includes(kind));
    return kinds.length === this.kinds.length ? this : this.with({ kinds });
  }
}

// Comparators return 0 on a tie and the sort is stable, so ties keep the projection's authored order.
export class Board {
  constructor(tree, progress, { sort = 'roadmap', kinds = [], search = '', branch = null } = {}) {
    if (!BOARD_SORTS.includes(sort)) throw new Error(`Unknown board sort "${sort}"`);

    this.states = UnlockRules.derive(tree, progress);
    this.overall = {
      done: tree.nodes.filter((step) => this.states.get(step.id) === 'complete').length,
      total: tree.nodes.length,
    };
    this.sort = sort;
    this.branch = branch !== null && tree.nodesById.has(branch) ? tree.nodesById.get(branch) : null;

    const scope = this.branch === null
      ? null
      : new Set([branch, ...tree.ancestorsOf(branch).map((step) => step.id), ...tree.descendantsOf(branch).map((step) => step.id)]);
    const hues = new Set(kinds);
    const needle = search.trim().toLowerCase();
    const shown = tree.nodes.filter((step) =>
      (scope === null || scope.has(step.id))
      && (hues.size === 0 || hues.has(step.color ?? DEFAULT_NODE_COLOR))
      && (needle === ''
        || (step.label ?? '').toLowerCase().includes(needle)
        || (step.description ?? '').toLowerCase().includes(needle)));
    const owed = owedCounts(tree, this.states);
    const cards = shown.map((step) => new BoardCard(tree, this.states, owed, step));
    const inColumn = (name) => cards.filter((card) => card.column === name);

    const completedAt = progress.completedAt ?? {};
    const byRoadmap = (a, b) => a.toGo - b.toGo || b.unlockCount - a.unlockCount;
    const byCreated = (a, b) => unknownLast(a.step.createdMs ?? null, b.step.createdMs ?? null,
      (msA, msB) => (sort === 'newest' ? msB - msA : msA - msB));
    const byNewestCompletion = (a, b) => unknownLast(completedAt[a.id] ?? null, completedAt[b.id] ?? null, (atA, atB) => atB - atA);
    const unfinishedOrder = sort === 'roadmap' ? byRoadmap : byCreated;

    this.locked = new BoardColumn('locked', inColumn('locked').sort(unfinishedOrder));
    this.upNext = new BoardColumn('upNext', inColumn('upNext').sort(unfinishedOrder));
    this.done = new BoardColumn('done', inColumn('done').sort(byNewestCompletion));
  }

  get columns() { return [this.locked, this.upNext, this.done]; }

  columnOf(id) {
    return COLUMN_OF_STATE[this.states.get(id)] ?? null;
  }

  // The cards a column shows: above twelve, Done folds to its twelve newest completions and a Show all row until expanded.
  shownCards(name, { doneExpanded = false } = {}) {
    const column = this[name];
    const folded = name === 'done' && !doneExpanded && column.count > DONE_RECENT_LIMIT;
    return { cards: folded ? column.cards.slice(0, DONE_RECENT_LIMIT) : column.cards, folded, total: column.count };
  }

  recentDone() {
    return this.shownCards('done');
  }
}

// The steps that arrived between two Boards of one roadmap: a step that became up next, or a new step that is not done.
// A reset back to Up next is a downward change and stays quiet; a roadmap with no step in common arrives whole, so nothing wakes.
export function arrivals(previous, next) {
  const arrived = new Set();
  let shared = false;
  for (const [id, state] of next.states) {
    const before = previous.states.get(id);
    shared ||= before !== undefined;
    if (state === 'available' && before === 'locked') arrived.add(id);
    if (state !== 'complete' && before === undefined) arrived.add(id);
  }
  return shared ? arrived : new Set();
}

function unknownLast(valueA, valueB, compare) {
  if (valueA === null || valueB === null) return (valueA === null) - (valueB === null);
  return compare(valueA, valueB);
}
