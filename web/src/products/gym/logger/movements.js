import { agoLabel, setLoadLabel } from '../log.js';

export const PICKER_MATCHES = 7;

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

export function movementOptions({ catalog = [], order = [], query = '' }) {
  const term = query.trim().toLowerCase();
  const available = catalog.filter((each) => !order.includes(each.id));
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
  return { matches: rows, empty: 'No movement by that name.', create: `Create “${query.trim()}”` };
}
