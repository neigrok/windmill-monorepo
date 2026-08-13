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
//
// A row is matched by its NAME and by every name this account used to call it (§N). The search and
// the mint are one module for the same reason the four silences are: which of them a query lands in
// decides whether there is a door out, and an alias that did not match would offer to create a
// second copy of a movement the lifter renamed last week.

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

// CREATING ONE ASKS EXACTLY TWO THINGS (§N screen 31): what you call it, and how it is loaded. The
// second is the one that matters — it decides what the ladder and the plate readout do at the rack —
// and everything else is admin: no approval, no moderation, no muscle-group tagging, no category
// tree, no "is this the same as Bench Press?" at creation time.
//
// So `pattern` is not asked for and claims as little as it can: `isolation` is the catch-all bucket
// rather than a statement about what the movement trains. Equipment IS asked for now, and it is read
// back — the movement's own page prints it under the name (record.js) — where before it was a silent
// `barbell` on every movement a lifter ever minted, including the machine ones.
export const CREATED_PATTERN = 'isolation';

// FOUR, AND THE SCHEMA HOLDS SIX. `cable` and `kettlebell` stay valid everywhere and seeded
// movements use them; a creation screen is not a taxonomy, and these are the four the board draws.
// `barbell` opens selected because it is the modal answer and was the silent assumption before this
// screen existed — one tap moves it, and now the tap is the lifter's.
export const EQUIPMENT_CHOICES = ['barbell', 'dumbbell', 'machine', 'bodyweight'];
export const DEFAULT_EQUIPMENT = 'barbell';

// A MOVEMENT IS FOUND BY WHAT THIS ACCOUNT CALLS IT AND BY WHAT IT USED TO CALL IT (§N). Renaming is
// a label moving over a stable id, so the old name stays as an alias and keeps finding the movement
// here — muscle memory outlives a rename, and a picker that only matched the new name would make a
// lifter hunt for a lift they have logged for a year. The aliases are on the catalog read, so this
// is one list matched two ways rather than a second search over a second read.
//
// The alias the match came THROUGH, which is null whenever the name itself matched: the row says why
// it is on the list, and a movement found by its own name needs no explanation. An empty query
// matches every name, so it can never be answered by an alias.
function aliasHit(exercise, term) {
  if (term === '' || exercise.name.toLowerCase().includes(term)) return null;
  return (exercise.aliases ?? []).find((alias) => alias.toLowerCase().includes(term)) ?? null;
}

function matchesQuery(exercise, term) {
  return exercise.name.toLowerCase().includes(term) || aliasHit(exercise, term) != null;
}

export function movementOptions({ catalog = [], order = [], query = '' }) {
  const term = query.trim().toLowerCase();
  const available = catalog.filter((each) => !order.includes(each.id));
  // A ROW, not the catalog entry it came from: the alias is part of what this row says and it is a
  // fact about the SEARCH rather than about the movement, so it is composed where the match is made.
  // Drawn only when the match came through it — an alias printed under every row would be a second
  // name on a screen whose whole job is picking one.
  const rows = available
    .filter((each) => matchesQuery(each, term))
    .slice(0, PICKER_MATCHES)
    .map((each) => ({ id: each.id, name: each.name, custom: each.custom === true, alias: aliasHit(each, term) }));
  if (rows.length > 0) return { matches: rows, empty: null, create: null };
  if (catalog.length === 0) {
    return { matches: rows, empty: 'The catalog didn’t load. It comes back when you have signal.', create: null };
  }
  if (available.length === 0) {
    return { matches: rows, empty: 'Every movement in the catalog is already in this session.', create: null };
  }
  if (catalog.some((each) => matchesQuery(each, term))) {
    return { matches: rows, empty: 'That movement is already in this session.', create: null };
  }
  // An empty query matches every available movement, so reaching here means something was typed —
  // the button can quote it without asking whether there is anything to quote.
  return { matches: rows, empty: 'No movement by that name.', create: `Create “${query.trim()}”` };
}
