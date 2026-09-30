// engine.md Appendix C, the gym backfill: one account's gym rows, as today's tables hold them (the legacy
// JSON of corpus/README.md "gym/backfill.json"), adopted in place as the records of `acct:<A>/gym`. Every
// register it writes carries one stamp `M:0:srv`; seqs, rc and ru, spent ids, the note counter, start
// receipts, the two projections and the scope digest follow. A scope that exists is left as it is.

import { replaceRow } from '../core/digest.js';
import { between } from '../core/fracindex.js';
import { compareRecords, compactRow } from '../core/rows.js';
import { ServerState } from '../server/state.js';

const SET_OF = (value) => value !== undefined && value !== null;

function registers(stamp, values) {
  const f = {};
  for (const [name, value] of Object.entries(values)) if (SET_OF(value)) f[name] = [value, stamp];
  return f;
}

// A line's scheme as its set rows hold it: absent when the line has none (the open line), each set
// naming only the columns that hold a value.
function schemeOf(rows) {
  if (!rows || rows.length === 0) return undefined;
  return [...rows].sort((a, b) => a.setIndex - b.setIndex).map((row) => {
    const set = {};
    if (SET_OF(row.reps)) set.reps = row.reps;
    if (SET_OF(row.weightKg)) set.weightKg = row.weightKg;
    return set;
  });
}

function sideOf(sets, restSeconds) {
  const side = {};
  if (SET_OF(sets)) side.sets = sets;
  if (SET_OF(restSeconds)) side.restSeconds = restSeconds;
  return side;
}

const BEFORE = new Set(['kept', 'removed', 'retargeted']);
const AFTER = new Set(['kept', 'added', 'retargeted']);

// Aliases newest first, as the catalog read orders them: created_at descending, then name.
function aliasesOf(legacy, exerciseId) {
  const rows = (legacy.aliases ?? []).filter((alias) => alias.exerciseId === exerciseId);
  rows.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.length ? rows.map((alias) => alias.name) : undefined;
}

// C.2's registers, record by record, each with C.6's rc and ru.
function recordsOf(legacy, seeds, stamp, M) {
  const minted = (t, id, values, rc, ru) => ({ t, id, life: ['alive', stamp], born: stamp, f: registers(stamp, values), rc, ru });
  const out = [];
  for (const routine of legacy.routines ?? []) {
    const entries = [...routine.entries].sort((a, b) => a.position - b.position).map((entry) => {
      const line = { exerciseId: entry.exerciseId };
      if (SET_OF(entry.restSeconds)) line.restSeconds = entry.restSeconds;
      const sets = schemeOf(entry.sets);
      if (sets) line.sets = sets;
      return line;
    });
    out.push(minted('routine', routine.id, { name: routine.name, position: routine.position, entries, createdDoor: routine.createdDoor }, routine.createdAt, M));
  }
  for (const exercise of legacy.exercises ?? []) {
    const values = { name: exercise.name, pattern: exercise.pattern, equipment: exercise.equipment, stepKg: exercise.stepKg, aliases: aliasesOf(legacy, exercise.id) };
    out.push(minted('exercise', exercise.id, values, exercise.createdAt, M));
  }
  const renamedSeeds = new Set([...(legacy.exerciseNames ?? []).map((line) => line.exerciseId), ...(legacy.aliases ?? []).map((alias) => alias.exerciseId)]);
  for (const id of [...renamedSeeds].filter((id) => Object.hasOwn(seeds, id)).sort()) {
    const line = (legacy.exerciseNames ?? []).find((row) => row.exerciseId === id);
    const at = line?.updatedAt ?? M;
    out.push({ t: 'exerciseName', id, f: registers(stamp, { name: line?.name, aliases: aliasesOf(legacy, id) }), rc: at, ru: at });
  }
  for (const session of legacy.sessions ?? []) {
    const { routineId, historyRoutineId, plan, startedAt, finishedAt, closedBy, displayName } = session;
    out.push(minted('session', session.id, { routineId, historyRoutineId, plan, startedAt, finishedAt, closedBy, displayName }, M, M));
  }
  for (const set of legacy.sets ?? []) {
    const { sessionId, exerciseId, weightKg, reps, kind, rpe, note, completedAt } = set;
    out.push({ ...minted('set', set.id, { sessionId, exerciseId, weightKg, reps, kind, rpe, note, completedAt }, M, M), v: { setNumber: set.setNumber } });
  }
  let key = null;
  for (const note of [...(legacy.notes ?? [])].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))) {
    key = between(key, null);
    out.push(minted('note', note.id, { title: note.title, body: note.body, ord: key }, note.createdAt, note.updatedAt));
  }
  for (const weighin of legacy.bodyweight ?? []) {
    out.push({ t: 'weighin', id: weighin.dateLocal, life: ['alive', stamp], f: registers(stamp, { kg: weighin.weightKg, recordedAt: weighin.recordedAt }), rc: weighin.updatedAt, ru: weighin.updatedAt });
  }
  if (legacy.preferences) {
    const { units, restSeconds, restSound, confirmHaptic, confirmSound, updatedAt } = legacy.preferences;
    out.push({ t: 'prefs', id: 'prefs', f: registers(stamp, { units, restSeconds, restSound, confirmHaptic, confirmSound }), rc: updatedAt, ru: updatedAt });
  }
  for (const proposal of legacy.proposals ?? []) {
    const changes = [...proposal.changes].sort((a, b) => a.position - b.position).map((row) => {
      const change = { kind: row.kind, exerciseId: row.exerciseId };
      if (BEFORE.has(row.kind)) change.before = sideOf(row.beforeSets, row.beforeRestSeconds);
      if (AFTER.has(row.kind)) change.after = sideOf(row.afterSets, row.afterRestSeconds);
      return change;
    });
    const { routineId, intent, proposedName, summary, door, connection, agent, threadId, state, supersededBy, settledAt } = proposal;
    const values = { routineId, intent, proposedName, summary, changes, door, connection, agent, threadId, state, supersededBy, settledAt };
    out.push(minted('proposal', proposal.id, values, proposal.createdAt, M));
  }
  return out;
}

// C.3: the ids today's receipts and revisions spend that no standing row holds.
function spentOf(legacy, stamp) {
  const standing = (rows) => new Set((rows ?? []).map((row) => row.id));
  const kinds = [
    ['set', [...(legacy.setRevisions ?? []).filter((row) => row.deleted).map((row) => row.setId), ...(legacy.writeReceipts ?? []).filter((row) => row.kind === 'set').map((row) => row.id)], standing(legacy.sets)],
    ['session', (legacy.writeReceipts ?? []).filter((row) => row.kind === 'session').map((row) => row.id), standing(legacy.sessions)],
    ['routine', legacy.routineCreations ?? [], standing(legacy.routines)],
    ['note', legacy.noteSaves ?? [], standing(legacy.notes)],
  ];
  const out = [];
  for (const [t, ids, alive] of kinds) {
    for (const id of [...new Set(ids)].sort()) if (!alive.has(id)) out.push({ t, id, born: stamp, lifeStamp: stamp });
  }
  return out;
}

export function backfill({ state, registry, account, legacy, M }) {
  const key = `acct:${account}/gym`;
  const next = state.clone();
  if (next.scope(key) !== undefined) return next;
  const stamp = `${M}:0:srv`;
  const records = recordsOf(legacy, next.product.seeds ?? {}, stamp, M);
  const spent = spentOf(legacy, stamp);
  if (records.length === 0 && spent.length === 0) return next;
  const order = registry.types instanceof Map ? [...registry.types.keys()] : registry.types.map((type) => type.type);
  const rank = (t) => order.indexOf(t);
  const all = [...records.map((record) => ({ record })), ...spent.map((entry) => ({ entry }))]
    .sort((a, b) => {
      const x = a.record ?? a.entry;
      const y = b.record ?? b.entry;
      return rank(x.t) - rank(y.t) || compareRecords(x, y);
    });
  const scope = next.insertScope(key, { kind: 'product', owner: account });
  all.forEach((item, index) => {
    const seq = index + 1;
    if (item.entry) next.putSpent(key, { ...item.entry, seq });
    else {
      const row = compactRow({ ...item.record, seq });
      next.putRow(key, row);
      scope.digest = replaceRow(scope.digest, undefined, row);
    }
  });
  scope.seq = all.length;
  const notes = records.filter((record) => record.t === 'note').length;
  if (notes) scope.counters.note = notes;
  const product = next.product;
  const starts = Object.fromEntries((legacy.writeReceipts ?? []).filter((row) => row.kind === 'session').map((row) => [row.id, row.sessionId]).sort());
  if (Object.keys(starts).length) (product.starts ??= {})[key] = starts;
  const revisions = Object.fromEntries((legacy.routines ?? []).map((routine) => [routine.id, routine.revision]).sort());
  if (Object.keys(revisions).length) (product.revisions ??= {})[key] = revisions;
  const bases = Object.fromEntries((legacy.proposals ?? []).map((proposal) => [proposal.id, { revision: proposal.baseRevision, name: proposal.baseName }]).sort());
  if (Object.keys(bases).length) (product.bases ??= {})[key] = bases;
  return new ServerState(next.toJSON());
}

