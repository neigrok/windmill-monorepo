// WHICH MOVEMENTS THE PICKER OFFERS — and, when it offers none, which of the four different
// silences it is looking at, and which one of them has a door out. They used to share one sentence,
// so a lifter who typed a letter the catalog does not hold was told their signal was out: the app
// reported a failure that had not happened and pointed them at the wrong thing to fix.
//
// Only an empty catalog may mention signal. A catalog that is entirely in the session says so. A
// query that matched a movement the SESSION already holds says that, and never offers to create it
// — the list this function filters is the available one, and reading a silence off it as "no
// movement by that name" would offer to mint a second Zercher Squat over a catalog that has one,
// splitting a movement's history between two ids in the one act the picker exists to prevent. And a
// query that matched nothing anywhere says only that — beside the offer to create what was just
// typed, which is why the sentence no longer echoes the query back: the button holds it, and
// holding it twice would be the same words in the same breath.
//
// AND WHAT EACH ROW IT DOES OFFER SAYS UNDER THE NAME — the lifter's own last set of that movement,
// or the fact that there has never been one. Same file, because it is the same row.

import { agoLabel, setLoadLabel } from '../log.js';

export const PICKER_MATCHES = 7;

// WHAT A ROW SAYS UNDER THE NAME (§B7): this lifter's own last time of the movement — the set and
// the day — or the fact that there is no last time to draw. Both readings come off one sparse read
// (gymApi.lastSets): an entry per movement this account has a last time for and nothing at all for
// the rest, so the second reading is an ABSENCE and never a zero anybody sent.
//
// The set is the last of that last-time block rather than the heaviest, and the day is that
// SESSION's start, so "last 82.5 × 5 · 3 days ago" is the set the phone's prefill would open on and
// the day the lifter stood in. Neither half is spelled here: a load and its reps read the way they
// read everywhere in this product — where a chin-up at nothing is `bodyweight × 8` rather than a
// zero — and an elapsed day is `agoLabel`, as on every other screen.
//
// AND THE ABSENCE SAYS `no last time`, NOT the design's `never logged`, because the read cannot
// carry that second claim. "Last time" is this product's own term and it excludes two things on
// purpose: the workout running right now (it is not a last time until it is finished) and warmup
// sets. So the movements a lifter is squatting THIS MINUTE are absent from this read — on day one,
// the wave's own subject, that is every movement they have ever touched — and Today, one tab over
// on this same surface, is drawing those very sets. `never logged` there is the desk contradicting
// itself about a lifter's history. `no last time` is exactly the negation of the other half of the
// line, and it is true of both silences: no finished block, or none that was not a ramp-up. The
// canon word is raised for the board and the phones rather than repeated here over bytes that do
// not support it.
export const NO_LAST_TIME_META = 'no last time';

export function lastSetsById(movements) {
  return new Map(movements.map((each) => [each.exerciseId, each]));
}

export function lastSetLabel(last, now = Date.now()) {
  if (!last) return NO_LAST_TIME_META;
  return `last ${setLoadLabel(last)} · ${agoLabel(last.at, now)}`;
}

// The two fields the wire requires of a created movement, and the picker asks for neither: canon
// screen 7 is a name and a button, and there is no taxonomy screen in this product. So the pair
// claims as little as it can. `isolation` is the catch-all bucket rather than a statement about what
// the movement trains, and equipment decides exactly one thing — the store's default ladder step,
// where barbell's 2.5 kg is the modal step across the whole table. Neither is read back on this
// surface: the web's ladder derives its steps from the weight itself (ladder.js).
export const CREATED_MOVEMENT = { pattern: 'isolation', equipment: 'barbell' };

export function movementOptions({ catalog = [], order = [], query = '' }) {
  const term = query.trim().toLowerCase();
  const available = catalog.filter((each) => !order.includes(each.id));
  const matches = available
    .filter((each) => each.name.toLowerCase().includes(term))
    .slice(0, PICKER_MATCHES);
  if (matches.length > 0) return { matches, empty: null, create: null };
  if (catalog.length === 0) {
    return { matches, empty: 'The catalog didn’t load. It comes back when you have signal.', create: null };
  }
  if (available.length === 0) {
    return { matches, empty: 'Every movement in the catalog is already in this session.', create: null };
  }
  if (catalog.some((each) => each.name.toLowerCase().includes(term))) {
    return { matches, empty: 'That movement is already in this session.', create: null };
  }
  // An empty query matches every available movement, so reaching here means something was typed —
  // the button can quote it without asking whether there is anything to quote.
  return { matches, empty: 'No movement by that name.', create: `Create “${query.trim()}”` };
}
