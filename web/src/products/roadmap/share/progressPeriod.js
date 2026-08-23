// How a tree's life divides into periods, and what each period held. Periods count from planting,
// never the calendar: a tree planted on a Thursday closes its weeks on Thursdays, and a period is
// always seven days — only its name ("Week 3" vs "Day 17") is a choice. A tree with no planting
// time (createdAt 0) has no period number, and the card names itself by the share ordinal.

import { ShareLedger } from '../persistence/ShareLedger.js';

export const PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_UNIT = 'week';
export const DAY_UNIT = 'day';
const LEDGER_PERIODS = 5; // the ticks BEFORE this one — the card appends its own, to six

// The period a tree is living in at `now`. `index` is 1 on planting day and rises every seven days;
// 0 means the planting time is unknown. `startedAt` is this period's boundary.
export class ProgressPeriod {
  constructor({ plantedAt = 0, now = Date.now(), unit = WEEK_UNIT, ordinal = 1 }) {
    this.plantedAt = plantedAt > 0 ? plantedAt : 0;
    this.now = now;
    this.unit = unit === DAY_UNIT ? DAY_UNIT : WEEK_UNIT;
    this.ordinal = ordinal;

    // A clock reading before planting floors elapsed at zero: the tree is in its first period.
    const elapsed = this.plantedAt === 0 ? 0 : Math.max(0, now - this.plantedAt);
    this.index = this.plantedAt === 0 ? 0 : Math.floor(elapsed / PERIOD_MS) + 1;
    this.day = this.plantedAt === 0 ? 0 : Math.floor(elapsed / DAY_MS) + 1;
    this.startedAt = this.plantedAt === 0 ? 0 : this.plantedAt + (this.index - 1) * PERIOD_MS;
  }

  // The card's chip text; the only thing the Week/Day choice changes.
  get label() {
    if (this.index === 0) return `Update #${this.ordinal}`;
    if (this.unit === DAY_UNIT) return `Day ${this.day}`;
    return `Week ${this.index}`;
  }
}

// What counts as new on this card: a pure set diff against the last card actually posted, so it is
// device-independent. A tree that has never posted has no diff to be "since", so the period start
// stands in — the one place local completion stamps are read, and they see only work marked in this
// browser, so a first card omits work it cannot place. `sinceAt` is when a carried-over card was
// posted, 0 when nothing was skipped.
export function newThisPeriod({ completed, states, completedAt = {}, prior = null, period }) {
  if (prior) {
    const last = new ProgressPeriod({ plantedAt: period.plantedAt, now: prior.at ?? 0, unit: period.unit });
    const skipped = period.index > 0 && last.index > 0 && period.index - last.index >= 2;
    return { lit: ShareLedger.since(completed, prior, states), sinceAt: skipped ? (prior.at ?? 0) : 0 };
  }

  // With no planting time, the last seven days are still a true period, just not a numbered one.
  const floor = period.startedAt > 0 ? period.startedAt : period.now - PERIOD_MS;
  const lit = [];
  for (const id of completed) {
    if (!states.has(id)) continue;
    const at = completedAt[id];
    if (typeof at !== 'number' || at < floor) continue;
    lit.push(id);
  }
  return { lit, sinceAt: 0 };
}

// How the card names the period a carried-over post covered: the same counter, lowercased. An
// unplanted tree has no sub-line.
export function sinceLabel({ plantedAt, at, unit }) {
  if (!at || plantedAt <= 0) return null;
  return new ProgressPeriod({ plantedAt, now: at, unit }).label.toLowerCase();
}

// The ticks behind the current one: what each period before this one published, oldest first.
// Never derive this from `completedAt` — that map is stamped only by completions made in this
// browser. A period with a posted card takes that card's own stamp, one with none takes the floor.
export function ledgerDeltas({ history = [], period, count = LEDGER_PERIODS }) {
  if (period.index < 2) return [];
  const deltas = [];
  for (let i = Math.max(1, period.index - count); i < period.index; i += 1) {
    const start = period.plantedAt + (i - 1) * PERIOD_MS;
    const posted = history.filter((card) => card.at >= start && card.at < start + PERIOD_MS);
    deltas.push(posted.reduce((sum, card) => sum + Math.max(0, card.delta ?? 0), 0));
  }
  return deltas;
}
