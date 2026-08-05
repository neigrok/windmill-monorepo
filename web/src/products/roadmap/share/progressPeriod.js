// How a tree's life divides into periods — and what each period held. A card in a SERIES needs
// three things the tree itself cannot hand it: which period this is, what counts as new in it, and
// how the periods before it went. All three fall out of one fact — when the tree was planted — so
// all three live here, pure, with no storage and no DOM.
//
// N COUNTS FROM PLANTING, NEVER THE CALENDAR WEEK. A tree planted on a Thursday closes its weeks on
// Thursdays. The period is always seven days; only its NAME is a choice. "Week 3" is what a feed
// reads best; "Day 17" is what #100DaysOfCode needs, because the hashtag and the card have to agree.
// Nobody else should have to think about it, which is why the choice is one segmented control that
// changes a label and nothing else — the rhythm underneath is the same seven days either way.
//
// A tree with no planting time (createdAt 0 — a local-born tree, or a row the server never stamped)
// has no week number at all. Rather than invent "Week 1", the card names itself by the share ordinal,
// which is true by construction: it IS the fourth update.

import { ShareLedger } from '../persistence/ShareLedger.js';

export const PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_UNIT = 'week';
export const DAY_UNIT = 'day';
const LEDGER_PERIODS = 5; // the ticks BEFORE this one — the card appends its own, to six

// The period a tree is living in at `now`. `index` is 1 on planting day and rises every seven days;
// 0 means the planting time is unknown, and the entity says so by naming itself after the ordinal
// instead. `startedAt` is this period's own boundary — the baseline a first card falls back to.
export class ProgressPeriod {
  constructor({ plantedAt = 0, now = Date.now(), unit = WEEK_UNIT, ordinal = 1 }) {
    this.plantedAt = plantedAt > 0 ? plantedAt : 0;
    this.now = now;
    this.unit = unit === DAY_UNIT ? DAY_UNIT : WEEK_UNIT;
    this.ordinal = ordinal;

    // A clock that reads before planting (skew, a hand-set device) is worth no drama: elapsed
    // floors at zero, so the tree is simply in its first period.
    const elapsed = this.plantedAt === 0 ? 0 : Math.max(0, now - this.plantedAt);
    this.index = this.plantedAt === 0 ? 0 : Math.floor(elapsed / PERIOD_MS) + 1;
    this.day = this.plantedAt === 0 ? 0 : Math.floor(elapsed / DAY_MS) + 1;
    this.startedAt = this.plantedAt === 0 ? 0 : this.plantedAt + (this.index - 1) * PERIOD_MS;
  }

  // What the card's chip prints, and the only thing the Week/Day choice changes.
  get label() {
    if (this.index === 0) return `Update #${this.ordinal}`;
    if (this.unit === DAY_UNIT) return `Day ${this.day}`;
    return `Week ${this.index}`;
  }
}

// What counts as NEW on this card. The baseline is the last card actually posted — a pure set diff,
// so it is device-independent and stays true for someone who posts fortnightly.
//
// A tree that has never posted a card has no diff to be "since", so the period start stands in. It
// is the one place local completion stamps are read, and it can only see work marked in THIS
// browser. That is a bounded, one-off exception, and it errs the safe way: a first card OMITS work
// it cannot place rather than asserting a period was quiet. Everything recurring — the offer, the
// ledger row — is built from set differences and published claims instead (see ledgerDeltas).
//
// A skipped period carries over rather than vanishing: post in week 3, skip week 4, and the week 5
// card lights both and says so. `sinceAt` is when that carried-over card was posted (0 when nothing
// was skipped) — a moment, not a sentence, because the sentence depends on a label the reader
// chooses and this is the wrong place to choose it.
export function newThisPeriod({ completed, states, completedAt = {}, prior = null, period }) {
  if (prior) {
    const last = new ProgressPeriod({ plantedAt: period.plantedAt, now: prior.at ?? 0, unit: period.unit });
    const skipped = period.index > 0 && last.index > 0 && period.index - last.index >= 2;
    return { lit: ShareLedger.since(completed, prior, states), sinceAt: skipped ? (prior.at ?? 0) : 0 };
  }

  // With no planting time to bound it either, the last seven days are still a true period — just
  // not a numbered one, which is exactly what the "Update #N" chip already admits.
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

// How the card names the period a carried-over post covered: the same counter, lowercased, so
// "steps done · since week 3" and the chip's "Week 5" can only ever agree. An unplanted tree has no
// numbered periods to have skipped, so it has no sub-line either.
export function sinceLabel({ plantedAt, at, unit }) {
  if (!at || plantedAt <= 0) return null;
  return new ProgressPeriod({ plantedAt, now: at, unit }).label.toLowerCase();
}

// The ticks behind the current one: what each period before this one PUBLISHED, oldest first.
//
// DO NOT DERIVE THIS FROM `completedAt`. That map is stamped only by completions made in this
// browser, so a week worked on a phone and posted from a desktop would render as a quiet tick — the
// card would publish a false claim about that week, in the user's own voice, to their followers.
// It is the same trap brief #20 was shaped to avoid: the card says "since I last shared" rather
// than "this week" precisely because per-node times are device-local and the server carries none.
//
// So a tick is a claim the user already made, and nothing else. A period holding a posted card
// takes that card's own stamp (ShareLedger's history), which can never contradict the picture
// they published; a period with no card takes the floor tick, which is exactly what canon's
// quiet period means — shown, never scolded. Post every period and this is byte-for-byte the
// height canon describes; skip one and it stays truthful instead of guessing.
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
