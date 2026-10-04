// engine.md Appendix C, the gym backfill: one account's gym rows, as today's tables hold them (the legacy
// JSON of corpus/README.md "gym/backfill.json"), adopted in place as the records of `acct:<A>/gym`. Every
// register it writes carries one stamp `M:0:srv`; seqs, rc and ru, spent ids, the note counter, start
// receipts, the two projections and the scope digest follow. A scope that exists is left as it is.

import { ZERO_DIGEST, replaceRow } from '../core/digest.js';
import { between } from '../core/fracindex.js';
import { jcs, sameJson } from '../core/jcs.js';
import { ownValue, setOwn } from '../core/maps.js';
import { compareRecords, compactRow, recordKey, stampsOf } from '../core/rows.js';
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

// C.8's frozen-input audit is separate from the writer and its digest calculation.
export function audit({ state, registry, account, legacy, M, seeds }) {
  const key = `acct:${account}/gym`;
  const check = (label, actual, expected) => {
    if (jcs({ value: actual }) !== jcs({ value: expected })) throw new Error(`gym adoption audit: ${label}`);
  };
  const stamp = `${M}:0:srv`;
  const expected = [];
  const keysOf = (row, names) => names.filter((name) => row[name] !== null && row[name] !== undefined);
  const hasAliases = (id) => (legacy.aliases ?? []).some((row) => row.exerciseId === id);
  const add = (t, id, rc, ru, fields, minted = false, life = minted) =>
    expected.push({ t, id, rc, ru, fields: fields.sort(), born: minted ? stamp : undefined, life: life ? ['alive', stamp] : undefined });
  for (const row of legacy.routines ?? []) add('routine', row.id, row.createdAt, M,
    [...keysOf(row, ['name', 'position', 'createdDoor']), 'entries'], true);
  for (const row of legacy.exercises ?? []) add('exercise', row.id, row.createdAt, M,
    [...keysOf(row, ['name', 'pattern', 'equipment', 'stepKg']), ...(hasAliases(row.id) ? ['aliases'] : [])], true);
  const renamed = new Set([
    ...(legacy.exerciseNames ?? []).map((row) => row.exerciseId),
    ...(legacy.aliases ?? []).map((row) => row.exerciseId),
  ]);
  for (const id of renamed) {
    if (!Object.hasOwn(seeds, id)) continue;
    const name = (legacy.exerciseNames ?? []).find((row) => row.exerciseId === id);
    const at = name?.updatedAt ?? M;
    add('exerciseName', id, at, at,
      [...keysOf(name ?? {}, ['name']), ...(hasAliases(id) ? ['aliases'] : [])]);
  }
  for (const row of legacy.sessions ?? []) add('session', row.id, M, M,
    keysOf(row, ['routineId', 'historyRoutineId', 'plan', 'startedAt', 'finishedAt', 'closedBy', 'displayName']), true);
  for (const row of legacy.sets ?? []) add('set', row.id, M, M,
    keysOf(row, ['sessionId', 'exerciseId', 'weightKg', 'reps', 'kind', 'rpe', 'note', 'completedAt']), true);
  for (const row of legacy.notes ?? []) add('note', row.id, row.createdAt, row.updatedAt,
    [...keysOf(row, ['title', 'body']), 'ord'], true);
  for (const row of legacy.bodyweight ?? []) add('weighin', row.dateLocal, row.updatedAt, row.updatedAt,
    keysOf({ kg: row.weightKg, recordedAt: row.recordedAt }, ['kg', 'recordedAt']), false, true);
  if (legacy.preferences) add('prefs', 'prefs', legacy.preferences.updatedAt, legacy.preferences.updatedAt,
    keysOf(legacy.preferences, ['units', 'restSeconds', 'restSound', 'confirmHaptic', 'confirmSound']));
  for (const row of legacy.proposals ?? []) add('proposal', row.id, row.createdAt, M,
    [...keysOf(row, ['routineId', 'intent', 'proposedName', 'summary', 'door', 'connection', 'agent', 'threadId', 'state', 'supersededBy', 'settledAt']), 'changes'], true);
  check('frozen row identities',
    state.rowsOf(key).map(({ t, id }) => ({ t, id })).sort(compareRecords),
    expected.map(({ t, id }) => ({ t, id })).sort(compareRecords));
  for (const frozen of expected) {
    const row = state.row(key, frozen.t, frozen.id);
    const label = `${row.t}/${row.id}`;
    check(`${label} register identities`, Object.keys(row.f ?? {}).sort(), frozen.fields);
    check(`${label} born`, row.born, frozen.born);
    check(`${label} life`, row.life, frozen.life);
    for (const envelope of stampsOf(row)) check(`${label} envelope`, envelope, stamp);
    check(`${label} rc`, row.rc, frozen.rc);
    check(`${label} ru`, row.ru, frozen.ru);
  }
  const candidates = new Map(['set', 'session', 'routine', 'note'].map((t) => [t, new Set()]));
  for (const row of legacy.setRevisions ?? []) if (row.deleted) candidates.get('set').add(row.setId);
  for (const row of legacy.writeReceipts ?? []) if (row.kind === 'set' || row.kind === 'session') candidates.get(row.kind).add(row.id);
  for (const id of legacy.routineCreations ?? []) candidates.get('routine').add(id);
  for (const id of legacy.noteSaves ?? []) candidates.get('note').add(id);
  const standing = new Set(expected.map((row) => recordKey(row.t, row.id)));
  const spent = [];
  for (const [t, ids] of candidates) for (const id of ids)
    if (!standing.has(recordKey(t, id))) spent.push({ t, id });
  check('frozen spent identities',
    state.spentOf(key).map(({ t, id }) => ({ t, id })).sort(compareRecords),
    spent.sort(compareRecords));
  for (const entry of state.spentOf(key)) {
    check(`${entry.t}/${entry.id} spent born`, entry.born, stamp);
    check(`${entry.t}/${entry.id} spent life`, entry.lifeStamp, stamp);
  }
  if (!expected.length && !spent.length) {
    check('empty account scope', state.scope(key), undefined);
    return true;
  }
  const order = registry.types instanceof Map ? [...registry.types.keys()] : registry.types.map((type) => type.type);
  [...expected, ...spent].sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t) || compareRecords(a, b))
    .forEach((row, index) => check(`${row.t}/${row.id} seq`, state.stored(key, row.t, row.id).seq, index + 1));
  check('scope seq', state.scope(key)?.seq, expected.length + spent.length);
  return true;
}

// C.10 upgrades adopted scopes from a separately frozen copy of their metadata columns.
export function upgradeMetadata({ state, registry, account, source, M }) {
  const key = `acct:${account}/gym`;
  const marker = ownValue(state.product.gymMetadataUpgrades, key);
  if (marker) {
    if (marker.version !== 5 || marker.M !== M || !sameJson(marker.source, source)) throw new Error('gym metadata manifest mismatch');
    return state.clone();
  }
  const next = state.clone();
  const scope = next.scope(key);
  const types = { routines: 'routine', proposals: 'proposal', notes: 'note' };
  const fields = { routine: ['revision', 'createdEntries'], proposal: ['baseRevision', 'baseName', 'changeCount'], note: ['updatedAt'] };
  const additions = [];
  for (const [table, t] of Object.entries(types)) {
    const columns = source[table] ?? [];
    const standing = next.rowsOf(key).filter((row) => row.t === t);
    if (!sameJson(columns.map((row) => row.id).sort(), standing.map((row) => row.id).sort())) throw new Error('gym metadata source roster mismatch');
    for (const column of columns) {
      const row = structuredClone(next.row(key, t, column.id));
      for (const name of fields[t]) {
        if (row.f?.[name]) throw new Error('gym metadata already present without marker');
        const value = column[name];
        if ((value === undefined || value === null) && name !== 'createdEntries') throw new Error('gym metadata source missing value');
        if (value !== undefined && value !== null) (row.f ??= {})[name] = [value, `${M}:0:srv`];
      }
      additions.push(row);
    }
  }
  const ids = new Set();
  for (const creation of source.routineCreations ?? []) {
    if (ids.has(creation.id) || next.row(key, 'routineCreation', creation.id) || creation.snapshot === undefined || creation.snapshot === null) throw new Error('gym metadata creation source invalid');
    ids.add(creation.id);
    additions.push({ t: 'routineCreation', id: creation.id, f: { snapshot: [structuredClone(creation.snapshot), `${M}:0:srv`] }, rc: M, ru: M });
  }
  if (!scope) {
    if (additions.length) throw new Error('gym metadata scope unadopted');
    return next;
  }
  const order = [...registry.types.keys()];
  additions.sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t) || compareRecords(a, b));
  for (const row of additions) {
    const before = next.row(key, row.t, row.id);
    row.seq = ++scope.seq;
    next.putRow(key, row);
    scope.digest = replaceRow(scope.digest, before, row);
  }
  for (const name of ['revisions', 'bases']) {
    if (!next.product[name]) continue;
    delete next.product[name][key];
    if (!Object.keys(next.product[name]).length) delete next.product[name];
  }
  next.product.gymMetadataUpgrades ??= {};
  setOwn(next.product.gymMetadataUpgrades, key, { version: 5, M, source: structuredClone(source),
    before: { scope: structuredClone(state.scope(key)), rows: structuredClone(state.rowsOf(key)), spent: structuredClone(state.spentOf(key)) } });
  return next;
}

// The audit builds expected rows from the retained pre-upgrade feed and columns, not the writer.
export function auditMetadata({ state, frozen, registry, account, source, M }) {
  const key = `acct:${account}/gym`;
  const check = (label, actual, expected) => {
    if (!sameJson(actual, expected)) throw new Error(`gym metadata audit: ${label}`);
  };
  const expected = frozen.clone();
  const scope = expected.scope(key);
  for (const [table, t] of [['routines', 'routine'], ['proposals', 'proposal'], ['notes', 'note']]) {
    const columns = source[table] ?? [];
    const rows = frozen.rowsOf(key).filter((row) => row.t === t);
    check('source roster', columns.map((row) => row.id).sort(), rows.map((row) => row.id).sort());
    const required = t === 'routine' ? ['revision'] : t === 'proposal' ? ['baseRevision', 'baseName', 'changeCount'] : ['updatedAt'];
    for (const column of columns) for (const name of required) {
      if (!Object.hasOwn(column, name) || column[name] === null || column[name] === undefined) throw new Error('gym metadata audit: missing source value');
    }
    for (const row of rows) for (const name of [...required, ...(t === 'routine' ? ['createdEntries'] : [])]) {
      if (row.f?.[name]) throw new Error('gym metadata audit: source already upgraded');
    }
  }
  const creations = source.routineCreations ?? [];
  check('creation source identities', new Set(creations.map((row) => row.id)).size, creations.length);
  for (const row of creations) {
    if (row.snapshot === null || row.snapshot === undefined || frozen.row(key, 'routineCreation', row.id)) throw new Error('gym metadata audit: creation source');
  }
  const changed = [];
  for (const old of frozen.rowsOf(key)) {
    const row = structuredClone(old);
    const table = { routine: 'routines', proposal: 'proposals', note: 'notes' }[row.t];
    if (!table) continue;
    const column = (source[table] ?? []).find((item) => item.id === row.id);
    if (!column) throw new Error('gym metadata audit: source roster');
    const names = row.t === 'routine' ? ['revision', 'createdEntries'] : row.t === 'proposal' ? ['baseRevision', 'baseName', 'changeCount'] : ['updatedAt'];
    for (const name of names) if (column[name] !== null && column[name] !== undefined) (row.f ??= {})[name] = [column[name], `${M}:0:srv`];
    changed.push(row);
  }
  for (const row of source.routineCreations ?? []) changed.push({ t: 'routineCreation', id: row.id,
    f: { snapshot: [structuredClone(row.snapshot), `${M}:0:srv`] }, rc: M, ru: M });
  if (!scope) {
    check('unadopted source', changed, []);
    check('empty account', state.toJSON(), frozen.toJSON());
    return true;
  }
  const order = [...registry.types.keys()];
  changed.sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t) || compareRecords(a, b));
  for (const row of changed) {
    row.seq = ++scope.seq;
    expected.putRow(key, row);
  }
  scope.digest = expected.rowsOf(key).reduce((sum, row) => replaceRow(sum, undefined, row), ZERO_DIGEST);
  for (const name of ['revisions', 'bases']) {
    if (!expected.product[name]) continue;
    delete expected.product[name][key];
    if (!Object.keys(expected.product[name]).length) delete expected.product[name];
  }
  expected.product.gymMetadataUpgrades ??= {};
  setOwn(expected.product.gymMetadataUpgrades, key, { version: 5, M, source: structuredClone(source),
    before: { scope: structuredClone(frozen.scope(key)), rows: structuredClone(frozen.rowsOf(key)), spent: structuredClone(frozen.spentOf(key)) } });
  check('rows, values, stamps, seq, receipts, counters, digest and manifest', state.toJSON(), expected.toJSON());
  return true;
}
