import { agoLabel, setLoadLabel } from '../log.js';

// A TYPED query is capped: seven rows are a shortlist, and dumping the catalogue under three letters
// is not an answer. An EMPTY query is not capped at all — it opens on the six and then hands over the
// whole catalogue, because a picker that shows only six has removed the ability to find the seventh.
export const PICKER_MATCHES = 7;
export const PICKER_FEATURED = 6;

// The eyebrow over the six — the bytes both phones already draw over theirs. It names the shortcut
// and counts it; it asserts no ranking over a log this page has not read. The catalogue follows it
// under no label of its own, set apart by the gap the stylesheet gives a second list.
export const FEATURED_HEAD = 'The six';

// `lastSets` is sparse: a missing movement is an absence, never a zero.
export const NO_LAST_TIME_META = 'no last time';

export function lastSetsById(movements) {
  return new Map(movements.map((each) => [each.exerciseId, each]));
}

export function lastSetLabel(last, now = Date.now()) {
  if (!last) return NO_LAST_TIME_META;
  return `last ${setLoadLabel(last)} · ${agoLabel(last.at, now)}`;
}

// The catch-all bucket: pattern is not asked for at creation.
export const CREATED_PATTERN = 'isolation';

// Four of the schema's six; cable and kettlebell stay valid, just not offered here.
export const EQUIPMENT_CHOICES = ['barbell', 'dumbbell', 'machine', 'bodyweight'];
export const DEFAULT_EQUIPMENT = 'barbell';

// Null whenever the name itself matched — including an empty query, which matches every name.
function aliasHit(exercise, term) {
  if (term === '' || exercise.name.toLowerCase().includes(term)) return null;
  return (exercise.aliases ?? []).find((alias) => alias.toLowerCase().includes(term)) ?? null;
}

function matchesQuery(exercise, term) {
  return exercise.name.toLowerCase().includes(term) || aliasHit(exercise, term) != null;
}

// The six are counted over a FIXED depth of the log and never over more. `useTrainingLog` boots on
// fifty sessions and appends another fifty every time the lifter taps Older on the Log tab, so
// counting over everything the page happens to hold would hand the same account a different six
// depending on where else it had been that visit. The sessions are newest first, so this is the
// newest fifty, whatever has been walked since.
export const TRAINED_WINDOW = 50;

// How often each movement has been trained, counted off the log THIS PAGE ALREADY HOLDS: a session
// summary carries the account's own name for every movement in it (`exercises`), so the count is
// sessions that named it, not working sets — the wire ranks nothing by use and this invents no read.
// A movement the log has never named is counted nowhere; what the log cannot fill is filled below.
export function trainedCounts(sessions = []) {
  const counted = new Map();
  for (const session of sessions.slice(0, TRAINED_WINDOW)) {
    for (const name of session.exercises ?? []) counted.set(name, (counted.get(name) ?? 0) + 1);
  }
  return counted;
}

// The six ids both phones open their own picker on (`MovementPicker.swift`, `MovementPicker.kt`): a
// client constant, never a server concept. Web ranks the account's own log first and fills what is
// left from these, so a section headed `The six` holds six of them and an account with no log yet is
// offered the same opener every surface offers.
export const PICKER_OPENERS = [
  'back-squat', 'bench-press', 'deadlift', 'overhead-press', 'barbell-row', 'chin-up',
];

export function mostTrained(available, sessions, limit = PICKER_FEATURED) {
  const counted = trainedCounts(sessions);
  const ranked = available
    .map((each, index) => ({ each, index, count: counted.get(each.name) ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((left, right) => (right.count - left.count) || (left.index - right.index))
    .slice(0, limit)
    .map((row) => row.each);
  if (ranked.length >= limit) return ranked;
  const openers = PICKER_OPENERS
    .map((id) => available.find((each) => each.id === id))
    .filter((each) => each != null && !ranked.includes(each));
  return [...ranked, ...openers].slice(0, limit);
}

const rowOf = (each, term) => ({
  id: each.id,
  name: each.name,
  custom: each.custom === true,
  alias: aliasHit(each, term),
});

export function movementOptions({ catalog = [], order = [], query = '', sessions = [] }) {
  const term = query.trim().toLowerCase();
  const available = catalog.filter((each) => !order.includes(each.id));
  const featured = term === '' ? mostTrained(available, sessions) : [];
  const rest = available.filter((each) => matchesQuery(each, term) && !featured.includes(each));
  const rows = (term === '' ? rest : rest.slice(0, PICKER_MATCHES)).map((each) => rowOf(each, term));
  const six = featured.map((each) => rowOf(each, term));
  if (rows.length > 0 || six.length > 0) return { featured: six, matches: rows, empty: null, create: null };
  if (catalog.length === 0) {
    return { featured: six, matches: rows, empty: 'The catalog didn’t load. It comes back when you have signal.', create: null };
  }
  if (available.length === 0) {
    return { featured: six, matches: rows, empty: 'Every movement in the catalog is already in this session.', create: null };
  }
  if (catalog.some((each) => matchesQuery(each, term))) {
    return { featured: six, matches: rows, empty: 'That movement is already in this session.', create: null };
  }
  return { featured: six, matches: rows, empty: 'No movement by that name.', create: `Create “${query.trim()}”` };
}
