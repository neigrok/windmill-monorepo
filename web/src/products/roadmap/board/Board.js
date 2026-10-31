// Three derived columns; filter, search and branch narrow the cards, never the states or progress.

import { DEFAULT_NODE_COLOR } from '../theme.js';
import { GENESIS_STAMP } from '../model/Legend.js';
import { UnlockRules, unmetPrerequisitesOf, owedStepsOf, unlocksOf } from '../model/UnlockRules.js';

export const BOARD_SORTS = ['roadmap', 'newest', 'oldest'];
export const DONE_RECENT_LIMIT = 12;

const COLUMN_OF_STATE = { locked: 'locked', available: 'upNext', complete: 'done' };
const GENESIS_MS = Number(GENESIS_STAMP.slice(0, GENESIS_STAMP.indexOf(':')));

class BoardCard {
  constructor(tree, states, step) {
    const state = states.get(step.id);
    const opens = state === 'complete' ? [] : unlocksOf(tree, states, step.id);
    const unmet = state === 'locked' ? unmetPrerequisitesOf(tree, states, step.id) : [];

    this.step = step;
    this.column = COLUMN_OF_STATE[state];
    this.unlockCount = opens.length;
    this.needs = state === 'locked'
      ? { need: unmet[0], extra: unmet.length - 1, toGo: owedStepsOf(tree, states, step.id).length }
      : null;
    this.unlocks = state === 'available' && opens.length > 0
      ? { first: opens[0], extra: opens.length - 1 }
      : null;
  }

  get id() { return this.step.id; }
}

class BoardColumn {
  constructor(name, cards) {
    this.name = name;
    this.cards = cards;
  }

  get count() { return this.cards.length; }
}

// A tie returns 0 and the sort is stable, so ties keep the projection's authored order.
class BoardOrder {
  constructor(tree, progress, sort) {
    this.sort = sort;
    this.depths = tree.ranks();
    this.completedAt = progress.completedAt ?? {};
  }

  comparatorFor(column) {
    if (this.sort !== 'roadmap') return (a, b) => this.byCreated(a, b);
    if (column === 'locked') return (a, b) => a.needs.toGo - b.needs.toGo || b.unlockCount - a.unlockCount;
    if (column === 'upNext') return (a, b) => this.depths.get(a.id) - this.depths.get(b.id) || b.unlockCount - a.unlockCount;
    return (a, b) => this.knownFirst(this.completedAt[a.id] ?? null, this.completedAt[b.id] ?? null, (atA, atB) => atB - atA);
  }

  byCreated(a, b) {
    const oldestFirst = (stampA, stampB) => stampA.ms - stampB.ms || stampA.counter - stampB.counter;
    const compare = this.sort === 'newest' ? (stampA, stampB) => oldestFirst(stampB, stampA) : oldestFirst;
    return this.knownFirst(this.createdAt(a), this.createdAt(b), compare);
  }

  // A seeded step carries the genesis stamp, which is no date at all.
  createdAt(card) {
    const stamp = card.step.createdAt;
    return stamp && stamp.ms > GENESIS_MS ? stamp : null;
  }

  knownFirst(valueA, valueB, compare) {
    if (valueA === null || valueB === null) return (valueA === null) - (valueB === null);
    return compare(valueA, valueB);
  }
}

export class Board {
  constructor(tree, progress, { sort = 'roadmap', kinds = [], query = '', branch = null } = {}) {
    if (!BOARD_SORTS.includes(sort)) throw new Error(`Unknown board sort "${sort}"`);

    this.states = UnlockRules.derive(tree, progress);
    this.progress = {
      done: tree.nodes.filter((step) => this.states.get(step.id) === 'complete').length,
      total: tree.nodes.length,
    };
    this.sort = sort;
    this.branch = branch !== null && tree.nodesById.has(branch) ? tree.nodesById.get(branch) : null;

    const scope = this.branch === null
      ? null
      : new Set([branch, ...tree.ancestorsOf(branch).map((step) => step.id), ...tree.descendantsOf(branch).map((step) => step.id)]);
    const hues = new Set(kinds);
    const needle = query.trim().toLowerCase();
    const shown = tree.nodes.filter((step) =>
      (scope === null || scope.has(step.id))
      && (hues.size === 0 || hues.has(step.color ?? DEFAULT_NODE_COLOR))
      && (needle === ''
        || (step.label ?? '').toLowerCase().includes(needle)
        || (step.description ?? '').toLowerCase().includes(needle)));
    const cards = shown.map((step) => new BoardCard(tree, this.states, step));

    const order = new BoardOrder(tree, progress, sort);
    const sorted = (name) => cards.filter((card) => card.column === name).sort(order.comparatorFor(name));

    this.locked = new BoardColumn('locked', sorted('locked'));
    this.upNext = new BoardColumn('upNext', sorted('upNext'));
    this.done = new BoardColumn('done', sorted('done'));
  }

  get columns() { return [this.locked, this.upNext, this.done]; }

  columnOf(id) {
    return COLUMN_OF_STATE[this.states.get(id)] ?? null;
  }

  // Above twelve the Done column folds to its first twelve and a Show all row for the rest.
  recentDone() {
    return {
      cards: this.done.cards.slice(0, DONE_RECENT_LIMIT),
      total: this.done.count,
      folded: this.done.count > DONE_RECENT_LIMIT,
    };
  }
}
