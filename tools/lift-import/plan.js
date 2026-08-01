// The pure half of the import: read a Lift export, fold its free-text exercise names onto catalog
// ids, derive the Windmill ids, and refuse every row the training log's domain would refuse —
// before a single byte goes over the wire. Nothing here touches the network or the disk, so every
// rule below is a unit test away.

export const MAX_INSTANT_MS = 253402300799000;   // 9999-12-31T23:59:59Z — Training.h kMaxInstantMs
export const MIN_WEIGHT_KG = -500;               // negative is LEGAL: band-assisted work
export const MAX_WEIGHT_KG = 500;
export const MIN_REPS = 1;
export const MAX_REPS = 500;

export class ImportRefusal extends Error {}

// The server's one id-shape rule, mirrored from Training.cpp `wellFormedId` so the tool can prove
// its derivation satisfies it instead of finding out over HTTP.
export function wellFormedId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

// The whole idempotency story in one line: the same Lift UUID always becomes the same Windmill id,
// so a second run replays onto the rows the first run wrote and changes nothing. 'ses_' + 32 hex
// is 36 characters — inside the server's 8..64 band.
export function windmillId(prefix, liftUuid) {
  const hex = String(liftUuid ?? '').toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new ImportRefusal(`not a lift uuid: ${liftUuid}`);
  return prefix + hex;
}

// Lift's worst decision was that an exercise is a free-text string, so "Bench Press", "Bench press"
// and "bench press" are three lifts forever. One normal form undoes it: case, punctuation, spacing
// and plurals all fold away, and what is left is compared against the catalog's display names.
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['’]/g, '')   // an apostrophe joins a word, it does not split one
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singular)
    .join(' ');
}

export function singular(word) {
  if (word.length <= 2) return word;   // 'ups' has to fold to 'up' for "Push Ups" to find "Push Up"
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function buildCatalogIndex(exercises) {
  const index = new Map();
  for (const exercise of exercises) {
    const key = normalizeName(exercise.name);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ id: exercise.id, name: exercise.name });
  }
  return index;
}

// Exactly one catalog movement under the normal form is a match. Nothing else is: a name that hits
// nothing, or hits two (display names are mutable user text, and phase-2 customs can collide with a
// seed), comes back for a human to decide. Ambiguity surfaced beats ambiguity guessed — the whole
// corpus's integrity is one bad guess away.
export function matchExercise(name, index) {
  const key = normalizeName(name);
  if (key === '') return { status: 'unresolved', exerciseId: null, candidates: [] };
  const hits = index.get(key) ?? [];
  if (hits.length === 1) return { status: 'resolved', exerciseId: hits[0].id, candidates: hits };
  if (hits.length > 1) return { status: 'ambiguous', exerciseId: null, candidates: hits };
  return { status: 'unresolved', exerciseId: null, candidates: nearestMovements(key, index) };
}

// Suggestions for the human, never a decision: catalog names sharing tokens with the unmatched one,
// best overlap first. These are printed beside the name in the mapping file as "what was considered".
export function nearestMovements(key, index, limit = 5) {
  const wanted = new Set(key.split(' ').filter(Boolean));
  const scored = [];
  for (const [candidateKey, entries] of index) {
    const other = new Set(candidateKey.split(' ').filter(Boolean));
    let shared = 0;
    for (const token of wanted) if (other.has(token)) shared += 1;
    if (shared === 0) continue;
    const score = shared / (wanted.size + other.size - shared);
    for (const entry of entries) scored.push({ ...entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ id, name }) => ({ id, name }));
}

// Phase one of the fold: every distinct Lift name either lands on a catalog id or lands in the
// unresolved list. A human mapping (mapping.json) wins over the automatic match — including a
// mapping the catalog cannot honor, which is itself an unresolved name, not a silent fallback.
export function resolveNames(names, catalog, overrides = {}) {
  const index = buildCatalogIndex(catalog);
  const catalogIds = new Set(catalog.map((exercise) => exercise.id));
  const resolved = new Map();
  const unresolved = [];

  for (const name of names) {
    const override = overrides[name];
    if (typeof override === 'string' && override.length > 0) {
      if (catalogIds.has(override)) {
        resolved.set(name, override);
        continue;
      }
      unresolved.push({
        name,
        reason: `the mapping points at "${override}", which the catalog does not hold`,
        candidates: nearestMovements(normalizeName(name), index),
      });
      continue;
    }
    const match = matchExercise(name, index);
    if (match.status === 'resolved') {
      resolved.set(name, match.exerciseId);
      continue;
    }
    unresolved.push({
      name,
      reason: match.status === 'ambiguous'
        ? 'more than one catalog movement carries this name'
        : 'no catalog movement carries this name',
      candidates: match.candidates,
    });
  }
  return { resolved, unresolved };
}

export function readExport(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (failure) {
    throw new ImportRefusal(`the export is not json: ${failure.message}`);
  }
  if (document?.app !== 'lift') throw new ImportRefusal('this is not a lift export (app != "lift")');
  if (document.version !== 1) throw new ImportRefusal(`unknown export version: ${document.version}`);
  if (!Array.isArray(document.sessions)) throw new ImportRefusal('the export has no sessions array');
  return document;
}

export function distinctExerciseNames(document) {
  const names = new Set();
  for (const session of document.sessions)
    for (const set of session?.sets ?? []) names.add(String(set?.exerciseName ?? ''));
  return [...names].sort();
}

export function isInstant(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_INSTANT_MS;
}

// Phase two: the export plus the resolved names becomes the exact list of writes to make — and,
// beside it, every row that will not be made and why. Lift's coach path applied no clamping at all,
// so its store holds rows the training log's constructors refuse; each one is dropped HERE, counted,
// and named in the summary. Silent failure is Lift's house style and is explicitly not ours.
export function planSessions(document, resolved) {
  const sessions = [];
  const skips = [];
  const counts = {
    sessionsTotal: 0,
    sessionsPlanned: 0,
    sessionsSkippedNoSets: 0,
    sessionsSkippedEverySetRefused: 0,
    sessionsSkippedUnreadable: 0,
    sessionsSkippedDuplicateId: 0,
    sessionsFinishedFromLastSet: 0,
    sessionsFinishRepaired: 0,
    setsTotal: 0,
    setsPlanned: 0,
    setsSkippedUnreadable: 0,
    setsSkippedDuplicateId: 0,
    setsSkippedUnresolvedName: 0,
    setsSkippedRepsOutOfBand: 0,
    setsSkippedWeightOutOfBand: 0,
    setsSkippedInstantOutOfBand: 0,
    setsWeightRounded: 0,
  };
  const seenSessionIds = new Set();
  const seenSetIds = new Set();

  for (const raw of document.sessions) {
    counts.sessionsTotal += 1;
    const rawSets = Array.isArray(raw?.sets) ? raw.sets : [];
    const label = `${raw?.name ?? 'unnamed'} (${raw?.id ?? 'no id'})`;

    let sessionId;
    try {
      sessionId = windmillId('ses_', raw?.id);
    } catch (failure) {
      counts.sessionsSkippedUnreadable += 1;
      counts.setsTotal += rawSets.length;
      skips.push({ scope: 'session', label, reason: failure.message, lostSets: rawSets.length });
      continue;
    }
    if (seenSessionIds.has(sessionId)) {
      counts.sessionsSkippedDuplicateId += 1;
      counts.setsTotal += rawSets.length;
      skips.push({ scope: 'session', label, reason: 'the export holds this session id twice', lostSets: rawSets.length });
      continue;
    }
    seenSessionIds.add(sessionId);

    if (!isInstant(raw?.startedAt)) {
      counts.sessionsSkippedUnreadable += 1;
      counts.setsTotal += rawSets.length;
      skips.push({ scope: 'session', label, reason: `startedAt is not an instant: ${raw?.startedAt}`, lostSets: rawSets.length });
      continue;
    }

    const sets = [];
    for (const rawSet of rawSets) {
      counts.setsTotal += 1;
      const setLabel = `${raw?.name ?? 'unnamed'} · ${rawSet?.exerciseName ?? 'unnamed movement'} (${rawSet?.id ?? 'no id'})`;

      let setId;
      try {
        setId = windmillId('set_', rawSet?.id);
      } catch (failure) {
        counts.setsSkippedUnreadable += 1;
        skips.push({ scope: 'set', label: setLabel, reason: failure.message });
        continue;
      }
      if (seenSetIds.has(setId)) {
        counts.setsSkippedDuplicateId += 1;
        skips.push({ scope: 'set', label: setLabel, reason: 'the export holds this set id twice' });
        continue;
      }

      const exerciseId = resolved.get(String(rawSet?.exerciseName ?? ''));
      if (!exerciseId) {
        counts.setsSkippedUnresolvedName += 1;
        skips.push({ scope: 'set', label: setLabel, reason: 'no catalog id for this movement' });
        continue;
      }
      if (!Number.isInteger(rawSet?.reps) || rawSet.reps < MIN_REPS || rawSet.reps > MAX_REPS) {
        counts.setsSkippedRepsOutOfBand += 1;
        skips.push({ scope: 'set', label: setLabel, reason: `reps out of the 1..500 band: ${rawSet?.reps}` });
        continue;
      }
      if (!Number.isFinite(rawSet?.weight) || rawSet.weight < MIN_WEIGHT_KG || rawSet.weight > MAX_WEIGHT_KG) {
        counts.setsSkippedWeightOutOfBand += 1;
        skips.push({ scope: 'set', label: setLabel, reason: `weight out of the -500..500 band: ${rawSet?.weight}` });
        continue;
      }
      if (!isInstant(rawSet?.completedAt)) {
        counts.setsSkippedInstantOutOfBand += 1;
        skips.push({ scope: 'set', label: setLabel, reason: `completedAt is not an instant: ${rawSet?.completedAt}` });
        continue;
      }
      // The store is numeric(6,2): a third decimal would be rounded on the way in. Nothing is lost
      // that a lifter can feel, but it is a change to their number and it gets counted, not hidden.
      if (Math.abs(rawSet.weight * 100 - Math.round(rawSet.weight * 100)) > 1e-9)
        counts.setsWeightRounded += 1;

      seenSetIds.add(setId);
      sets.push({
        id: setId,
        exerciseId,
        weightKg: rawSet.weight,
        reps: rawSet.reps,
        completedAt: rawSet.completedAt,
      });
    }

    // A setless session is Lift's accidental-Finish artifact — noise, not history. So is a session
    // whose every set was refused: an empty shell in the log would claim a workout that has no reps.
    if (sets.length === 0) {
      if (rawSets.length === 0) {
        counts.sessionsSkippedNoSets += 1;
        skips.push({ scope: 'session', label, reason: 'no sets — an accidental Finish, not a workout' });
      } else {
        counts.sessionsSkippedEverySetRefused += 1;
        skips.push({ scope: 'session', label, reason: `every one of its ${rawSets.length} sets was refused` });
      }
      continue;
    }

    sets.sort((a, b) => a.completedAt - b.completedAt);
    const lastSetAt = sets[sets.length - 1].completedAt;
    const closeAt = Math.max(lastSetAt, raw.startedAt);

    // An open session ends at its last real activity, not at whenever we noticed — gym's own
    // auto-close rule, applied to Lift's abandoned sessions. A finish the session could not have
    // had (absent, out of band, or running backwards against its own start) gets the same instant.
    let finishedAt = raw?.finishedAt;
    let finishedFrom = 'export';
    if (finishedAt === null || finishedAt === undefined) {
      finishedAt = closeAt;
      finishedFrom = 'lastSet';
      counts.sessionsFinishedFromLastSet += 1;
    } else if (!isInstant(finishedAt) || finishedAt < raw.startedAt) {
      skips.push({ scope: 'session', label, reason: `finishedAt ${finishedAt} could not close this session — closed at its last set instead` });
      finishedAt = closeAt;
      finishedFrom = 'repaired';
      counts.sessionsFinishRepaired += 1;
    }

    counts.sessionsPlanned += 1;
    counts.setsPlanned += sets.length;
    sessions.push({
      id: sessionId,
      label,
      startedAt: raw.startedAt,
      finishedAt,
      finishedFrom,
      sets,
    });
  }

  return { sessions, skips, counts };
}
