// Three columns of the domain's Board (`BoardRead`): filter, search and branch narrow the cards, never the states or
// progress.

import { DEFAULT_NODE_COLOR } from '../theme.js';
import { COLUMN_OF_STATE, domainReading, readBoard } from '../model/domainReads.js';

export const BOARD_SORTS = ['roadmap', 'newest', 'oldest'];
export const DONE_RECENT_LIMIT = 12;


// A card of the domain's Board with its step: what a Locked card needs and an Up next card opens, by step.
class BoardCard {
  constructor(tree, card) {
    this.step = tree.nodesById.get(card.id);
    this.opening = this.step.opening ?? null;
    this.column = card.column;
    this.unlockCount = card.unlockCount;
    this.needs = card.needs && { need: tree.nodesById.get(card.needs.first), extra: card.needs.extra, toGo: card.needs.toGo };
    this.unlocks = card.unlocks && { first: tree.nodesById.get(card.unlocks.first), extra: card.unlocks.extra };
  }

  get id() { return this.step.id; }
  get toGo() { return this.needs?.toGo ?? 0; }
}

class BoardColumn {
  constructor(name, cards, shown) {
    this.name = name;
    this.cards = cards;
    this.shown = shown;
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

  predicate(tree) {
    const branchExists = this.branch !== null && tree?.nodesById.has(this.branch);
    const scope = branchExists ? new Set([
      this.branch,
      ...tree.ancestorsOf(this.branch).map((step) => step.id),
      ...tree.descendantsOf(this.branch).map((step) => step.id),
    ]) : null;
    const hues = new Set(this.kinds);
    const needle = this.search.trim().toLowerCase();
    return (step) => {
      if (scope !== null && !scope.has(step.id)) return false;
      if (hues.size > 0 && !hues.has(step.color ?? DEFAULT_NODE_COLOR)) return false;
      if (needle === '') return true;
      return (step.label ?? '').toLowerCase().includes(needle)
        || (step.description ?? '').toLowerCase().includes(needle);
    };
  }

  revealing(step, tree) {
    const cleared = {};
    for (const [key, empty] of [['kinds', []], ['search', ''], ['branch', null]]) {
      const restriction = new BoardQuery({ [key]: this[key] });
      if (!restriction.predicate(tree)(step)) cleared[key] = empty;
    }
    if (Object.keys(cleared).length === 0) return this;
    return this.with(cleared);
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

// The domain's Board of the room's roadmap, its cards by step.
export class Board {
  constructor(tree, progress, options = new BoardQuery()) {
    const query = options instanceof BoardQuery ? options : new BoardQuery(options);
    const read = readBoard(tree, progress, { sort: query.sort, kinds: query.kinds, search: query.search, branch: query.branch }).result();
    const cards = new Map(read.cards.map((card) => [card.id, new BoardCard(tree, card)]));

    this.treeId = tree.id;
    this.states = domainReading(tree, progress).states;
    this.overall = read.overall;
    this.sort = read.sort;
    this.branch = read.branch === null ? null : tree.nodesById.get(read.branch);
    const columns = new Map(read.columns.map((column) => [column.name, new BoardColumn(column.name, column.ids.map((id) => cards.get(id)), column.shown.length)]));
    this.locked = columns.get('locked');
    this.upNext = columns.get('upNext');
    this.done = columns.get('done');
  }

  get columns() { return [this.locked, this.upNext, this.done]; }

  columnOf(id) {
    return COLUMN_OF_STATE[this.states.get(id)] ?? null;
  }

  // The cards a column shows: above twelve, Done folds to its twelve newest completions and a Show all row until expanded.
  shownCards(name, { doneExpanded = false } = {}) {
    const column = this[name];
    const folded = !doneExpanded && column.shown < column.count;
    return { cards: folded ? column.cards.slice(0, column.shown) : column.cards, folded, total: column.count };
  }

  recentDone() {
    return this.shownCards('done');
  }
}

export function regroup(previous, next) {
  const arrived = new Set();
  const leaving = new Set();
  const moved = [];
  if (previous.treeId !== next.treeId) return { arrived, leaving, moved };
  for (const [id, state] of next.states) {
    const before = previous.states.get(id);
    if (state === 'available' && before === 'locked') arrived.add(id);
    if (state !== 'complete' && before === undefined) arrived.add(id);
    if (before !== undefined && state !== before) {
      leaving.add(id);
      moved.push({ id, from: previous.columnOf(id), to: next.columnOf(id) });
    }
  }
  for (const id of previous.states.keys()) if (!next.states.has(id)) leaving.add(id);
  return { arrived, leaving, moved };
}
