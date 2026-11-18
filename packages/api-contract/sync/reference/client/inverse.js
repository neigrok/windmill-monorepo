// K-3 Undo and Redo of an act (§7.3 Undo of an act): an inverse request reserves its slots in the outbox at
// once, each an ordinary entry at the end of commit order that carries its optimistic projection and blocks
// the sender until it is materialized. Once every source of the act has an authoritative outcome, the slots
// bind the latest versions the act owns and its first preimages into restore or inverse commands, in one
// transaction; a slot left with nothing settles unnumbered. The inverse act journals its own preimages,
// so a Redo takes back only what the Undo actually applied.

import { Clock } from '../core/clock.js';
import { jcs, sameJson } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { creatableFault, inverseOutcomes, restorableSlotFault, sameRecord, sameSlot, valueIn, versionIn } from '../core/restore.js';
import { recordKey } from '../core/rows.js';
import { undo } from './hold.js';
import { collectJournal, ordinalOf, sourceOf } from './journal.js';
import { effectsOf } from './projections.js';
import { drawn } from './views.js';

export function requestOf(replica, requestId) {
  return replica.inverses.find((request) => request.requestId === requestId);
}

// The slot an inverse entry reserved, with its request.
export function slotOf(replica, entry) {
  const request = entry.inverseOf === undefined ? undefined : requestOf(replica, entry.inverseOf);
  const slot = request?.slots.find((candidate) => candidate.localId === entry.localId);
  return slot ? { request, slot } : null;
}

// A slot's planned recipe, from the act's own recipes: one restore slot a source entry for its generic recipes,
// a target restored once from its first preimage, and one slot each product command recipe. Undo runs the act
// backwards: the last source's slots come first.
function plannedSlots(act, replacement) {
  const sources = replacement ? act.sourceEntries.map((source) => ({ ...source,
    recipes: replacement.find((item) => item.index === ordinalOf(source.localId))?.recipes ?? [] })) : act.sourceEntries;
  const named = new Set();
  const firstOf = new Map();
  for (const source of sources) {
    for (const preimage of source.preimages) if (!firstOf.has(jcs(preimage.target))) firstOf.set(jcs(preimage.target), preimage.value);
  }
  const slots = [];
  for (const source of [...sources].reverse()) {
    const operations = [];
    let command;
    for (const recipe of source.recipes) {
      if (recipe.kind === 'command') {
        slots.push({ scope: source.originScope, recipe: structuredClone(recipe) });
        continue;
      }
      command = recipe.restoreCommand;
      if (recipe.kind === 'createdRecord') operations.push({ kind: 'createdRecord', record: structuredClone(recipe.record) });
      else for (const { target } of recipe.targets) operations.push({ kind: 'field', target: structuredClone(target), before: structuredClone(firstOf.get(jcs(target))) });
    }
    const unique = operations.filter((op) => {
      const key = jcs(op.kind === 'field' ? op.target : op.record);
      if (named.has(key)) return false;
      named.add(key);
      return true;
    });
    if (unique.length) slots.push({ scope: source.originScope, recipe: { kind: 'restore', command, operations: unique } });
  }
  return slots;
}

// The optimistic projection of a restore slot over `view`, at `stamp`: each operation as the restore would
// write it, one delta a record. An operation whose record the view lacks projects nothing.
function projectionOf(registry, view, operations, stamp) {
  const deltas = new Map();
  for (const op of operations) {
    const address = op.kind === 'field' ? op.target : op.record;
    const key = recordKey(address.t, address.id);
    if (op.kind === 'createRecord') {
      if (view.has(key)) continue;
      const created = { t: address.t, id: address.id, life: ['alive', stamp], ...(registry.type(address.t).hasBorn ? { born: stamp } : {}) };
      if (Object.keys(op.values.f ?? {}).length) created.f = Object.fromEntries(Object.entries(op.values.f).map(([name, value]) => [name, [value, stamp]]));
      if (Object.keys(op.values.x ?? {}).length) created.x = Object.fromEntries(Object.entries(op.values.x).map(([name, text]) => [name, { text, base: { text: '' } }]));
      deltas.set(key, created);
      continue;
    }
    const current = view.get(key);
    if (!current) continue;
    const delta = deltas.get(key) ?? { t: address.t, id: address.id, ...(registry.type(address.t).hasBorn ? { born: current.born } : {}) };
    deltas.set(key, delta);
    if (op.kind === 'createdRecord') delta.life = ['dead', stamp];
    else if (op.target.slot.kind === 'life') delta.life = [op.before, stamp];
    else if (op.target.slot.kind === 'field') delta.f = { ...delta.f, [op.target.slot.name]: [op.before, stamp] };
    else delta.x = { ...delta.x, [op.target.slot.name]: { text: op.before, base: { text: valueIn(current, op.target.slot) ?? '' } } };
  }
  return [...deltas.values()];
}

// The inverse act's own journal: each restore slot a source whose recipes put back what the inverse replaces,
// from the values the slot's targets read before it. A created record comes back by its life only where a
// write can bring it back; a product slot has no generic recipe, and its Redo is the product's.
function inverseJournal(registry, replica, inverseActId, slots) {
  const sourceEntries = slots.map(({ localId, scope, recipe }) => {
    if (recipe.kind !== 'restore') return { localId, originScope: scope, recipes: [], preimages: [], attempts: [] };
    const view = drawn(replica, registry, scope);
    const targets = recipe.operations.flatMap((op) => {
      if (op.kind === 'field') return [op.target];
      if (op.kind === 'createRecord') return [];
      const type = registry.type(op.record.t);
      return type.identity === 'keyed' || type.revivable ? [{ ...op.record, slot: { kind: 'life' } }] : [];
    });
    const recreated = recipe.operations.filter((op) => op.kind === 'createRecord')
      .map((op) => ({ kind: 'createdRecord', restoreCommand: recipe.command, record: structuredClone(op.record) }));
    const preimages = targets.flatMap((target) => {
      const value = valueIn(view.get(recordKey(target.t, target.id)), target.slot);
      return value === undefined ? [] : [{ target: structuredClone(target), value: structuredClone(value) }];
    });
    const restorable = preimages.map(({ target }) => ({ target: structuredClone(target) }));
    const recipes = [...(restorable.length ? [{ kind: 'fields', restoreCommand: recipe.command, targets: restorable }] : []), ...recreated];
    return { localId, originScope: scope, recipes, preimages, attempts: [] };
  });
  return { version: 1, actId: inverseActId, retained: true, sourceEntries };
}

// requestInverse(sourceActId, inverseSlots?): Undo of an opted act, or Redo of an inverse act. An act whose
// entries are all still held is cancelled at once, as `undo` cancels it. Otherwise the slots are reserved,
// projected and, where every source is already authoritative, materialized, all in this transaction.
// `replacement`, a complete list [{index, recipes}] by source ordinal, stands in for the stored recipes.
export function requestInverse(replica, ctx, sourceActId, replacement) {
  const { registry } = ctx;
  const existing = replica.inverses.find((request) => request.sourceActId === sourceActId);
  if (existing) return readInverseResult(replica, existing.requestId);
  const act = replica.journal.find((candidate) => candidate.actId === sourceActId);
  const cancellation = replica.cancellations.find((candidate) => candidate.inverseActId === sourceActId);
  if (!act && !cancellation) return { kind: 'unavailable', requestId: null, reason: 'not-reversible' };
  const entries = replica.entries().filter((entry) => entry.gestureId === sourceActId);
  if (act && entries.length > 0 && entries.every((entry) => entry.state === 'held')) return cancelHeld(replica, ctx, act, entries);

  const planned = act ? plannedSlots(act, replacement) : redoSlots(registry, cancellation);
  const inverseActId = ctx.nextGestureId();
  const requestId = ctx.nextGestureId();
  const physNow = ctx.deviceNow + replica.meta.serverOffsetMs;
  const clock = new Clock(replica.meta.hlc, ctx.actor, () => physNow);
  clock.observe(replica.meta.hlcHigh);
  const stamp = clock.tick();
  const firstOrder = replica.nextCommitOrder();
  const touched = new Map();
  const slots = planned.map(({ scope, recipe }, k) => ({ localId: `${inverseActId}/${k}`, commitOrder: firstOrder + k, scope, recipe, state: 'waiting' }));
  const before = new Map(slots.map(({ scope }) => [scope, drawn(replica, registry, scope)]));
  const journal = inverseJournal(registry, replica, inverseActId, slots);
  for (const slot of slots) {
    const d = slot.recipe.kind === 'restore' ? projectionOf(registry, before.get(slot.scope), slot.recipe.operations, stamp) : [];
    for (const delta of d) touched.set(`${slot.scope}|${recordKey(delta.t, delta.id)}`, { scope: slot.scope, key: recordKey(delta.t, delta.id) });
    replica.outbox.push({
      localId: slot.localId, gestureId: inverseActId, lineage: replica.lineage(), scope: slot.scope, state: 'ready',
      commitOrder: slot.commitOrder, releaseAt: 0, stamp, inverseOf: requestId,
      intent: { scope: slot.scope, cmd: { name: slot.recipe.command, args: null }, gestureId: inverseActId },
      predictions: [{ scope: slot.scope, d }],
    });
  }
  const localChanged = [...touched.values()].some(({ scope, key }) => !sameJson(before.get(scope).get(key), drawn(replica, registry, scope).get(key)));
  replica.inverses.push({ version: 1, requestId, sourceActId, inverseActId, state: 'waiting', localChanged,
    slots: slots.map(({ localId, commitOrder, recipe, state }) => ({ localId, commitOrder, recipe, state })) });
  replica.journal.push(journal);
  replica.meta.hlc = clock.pair;
  replica.meta.hlcHigh = stamp;
  materialize(replica, ctx, requestOf(replica, requestId));
  return readInverseResult(replica, requestId);
}

// An act every entry of which is still held never reached the server: Undo cancels it in place, its dependents
// folded silently, and reports whether anything drawn changed. The act leaves the journal.
function cancelHeld(replica, ctx, act, entries) {
  const { registry } = ctx;
  const scopes = [...new Set(entries.flatMap((entry) => effectsOf(entry).map(({ scope }) => scope)))];
  const before = new Map(scopes.map((scope) => [scope, drawn(replica, registry, scope)]));
  const written = entries.flatMap((entry) => effectsOf(entry).flatMap(({ scope, d }) => d.map((delta) => ({ entry, scope, delta }))));
  undo(replica, registry, ctx.ended, act.actId);
  const after = new Map(scopes.map((scope) => [scope, drawn(replica, registry, scope)]));
  const changed = scopes.some((scope) => !sameJson([...before.get(scope)], [...after.get(scope)]));
  const inverseActId = ctx.nextGestureId();
  const requestId = ctx.nextGestureId();
  replica.journal = replica.journal.filter((candidate) => candidate !== act);
  replica.cancellations.push({ version: 1, inverseActId, cancelledActId: act.actId, units: cancellationUnits(replica, registry, written, before, after) });
  replica.inverses.push({ version: 1, requestId, sourceActId: act.actId, inverseActId, state: 'settled', slots: [],
    result: { kind: 'cancelled', requestId, inverseActId, changed } });
  return readInverseResult(replica, requestId);
}

// The changes a cancellation actually took out of `drawn`, each with what restoring it must find: a register
// the cancelled act wrote that now reads otherwise, at the version it now reads (accepted, a pending entry's,
// or absent in the record's incarnation), and a record it created that is now absent, with the act's own
// creation values. A later local edit that masks the act's write took nothing out, and is no unit.
function cancellationUnits(replica, registry, written, before, after) {
  const units = new Map();
  for (const { entry, scope, delta } of written) {
    const type = registry.type(delta.t);
    const key = recordKey(delta.t, delta.id);
    const was = before.get(scope).get(key);
    const now = after.get(scope).get(key);
    const record = { scope, t: delta.t, id: delta.id };
    if (!now) {
      if (!was || creatableFault(type)) continue;
      const unit = units.get(jcs(['record', record])) ?? { kind: 'createdRecord', ownerLocalId: entry.localId, record, redoValues: {},
        restored: { kind: 'recordAbsent', epoch: replica.meta.serverEpoch } };
      for (const name of Object.keys(delta.f ?? {})) if (type.field(name)?.writer === 'client') (unit.redoValues.f ??= {})[name] = was.f[name][0];
      for (const name of Object.keys(delta.x ?? {})) if (type.field(name)?.writer === 'client') (unit.redoValues.x ??= {})[name] = was.x[name];
      units.set(jcs(['record', record]), unit);
      continue;
    }
    const slots = [...(delta.life ? [{ kind: 'life' }] : []), ...Object.keys(delta.f ?? {}).map((name) => ({ kind: 'field', name })),
      ...Object.keys(delta.x ?? {}).map((name) => ({ kind: 'text', name }))];
    for (const slot of slots) {
      if (restorableSlotFault(type, slot) || sameJson(valueIn(was, slot) ?? null, valueIn(now, slot) ?? null)) continue;
      const target = { ...record, slot };
      units.set(jcs(['field', target]), { kind: 'field', ownerLocalId: entry.localId, target, redoValue: structuredClone(valueIn(was, slot)),
        restored: referenceOf(replica, registry, target, now) });
    }
  }
  return [...units.values()];
}

// Where the value a target reads now comes from: a pending entry that wrote it, the confirmed row's accepted
// version, or, unset, the record's birth.
function referenceOf(replica, registry, target, now) {
  const epoch = replica.meta.serverEpoch;
  const writer = (slot) => replica.entries().reverse().find((entry) => effectsOf(entry, { active: true })
    .some(({ scope, d }) => scope === target.scope && d.some((delta) => delta.t === target.t && sameJson(delta.id, target.id) && writes(delta, slot, now))));
  const pendingOf = (slot) => {
    const entry = writer(slot);
    return entry ? { kind: 'pending', localId: entry.localId, target: { ...target, slot } } : null;
  };
  const confirmed = replica.confirmedRow(target.scope, target.t, target.id);
  const accepted = (slot) => {
    const version = versionIn(confirmed, slot);
    return version ? { kind: 'accepted', epoch, version } : null;
  };
  const current = pendingOf(target.slot) ?? accepted(target.slot);
  if (current) return current;
  const birth = registry.type(target.t).hasBorn ? pendingOf({ kind: 'born' }) ?? accepted({ kind: 'born' }) : null;
  return { kind: 'fieldAbsent', epoch, recordBirth: birth };
}

// Whether a delta writes the slot as `now` reads it: the register at the stamp `now` holds, or the text.
function writes(delta, slot, now) {
  if (slot.kind === 'born') return delta.born !== undefined && delta.born === now.born && delta.life?.[1] === delta.born;
  if (slot.kind === 'life') return delta.life !== undefined && sameJson(delta.life, now.life);
  if (slot.kind === 'field') return delta.f?.[slot.name] !== undefined && sameJson(delta.f[slot.name], now.f?.[slot.name]);
  return delta.x?.[slot.name] !== undefined;
}

// A Redo of a cancellation reserves ordinary restore slots, one a scope, in the order the cancelled act wrote:
// each field back to the value the act wrote, under the version reference it now reads, and each created
// record created again only where it is still wholly absent.
function redoSlots(registry, cancellation) {
  const byScope = new Map();
  for (const unit of [...cancellation.units].sort((a, b) => ordinalOf(a.ownerLocalId) - ordinalOf(b.ownerLocalId))) {
    const scope = unit.kind === 'field' ? unit.target.scope : unit.record.scope;
    const command = [...registry.commands.values()].find((candidate) => candidate.engine === 'restore' && candidate.scope === registry.scopeKindOf(scope));
    const type = unit.kind === 'field' ? unit.target.t : unit.record.t;
    if (!command?.predicts.includes(type)) continue;
    const slot = byScope.get(scope) ?? { scope, recipe: { kind: 'restore', command: command.name, operations: [] } };
    byScope.set(scope, slot);
    slot.recipe.operations.push(unit.kind === 'field'
      ? { kind: 'field', target: structuredClone(unit.target), before: structuredClone(unit.redoValue), reference: structuredClone(unit.restored) }
      : { kind: 'createRecord', record: structuredClone(unit.record), values: structuredClone(unit.redoValues), reference: structuredClone(unit.restored) });
  }
  return [...byScope.values()];
}

// Whether every source of an act has its authoritative outcome: an entry still queued, sent or held, or
// acknowledged in another epoch, has none yet.
function authoritative(replica, act) {
  return act.sourceEntries.every((source) => {
    const entry = replica.entry(source.localId);
    if (!entry) return true;
    return entry.state === 'acked' && source.attempts.some((attempt) => attempt.outcome === 'ok' && attempt.epoch === replica.meta.serverEpoch);
  });
}

// The accepted receipts the act's sources own in the current epoch, in commit order; a source whose history
// another epoch took is `lost`.
function ownedHistory(replica, act) {
  return [...act.sourceEntries].sort((a, b) => ordinalOf(a.localId) - ordinalOf(b.localId)).map((source) => ({
    lost: source.unavailable === true,
    effects: source.attempts.find((attempt) => attempt.outcome === 'ok' && attempt.epoch === replica.meta.serverEpoch)?.acceptedEffects ?? [],
  }));
}

const rowsOf = (effects, address) => effects.filter(({ scope }) => scope === address.scope)
  .flatMap(({ rows }) => rows.filter((row) => row.t === address.t && sameJson(row.id, address.id)));

// A Redo of a cancellation waits while an entry its references name has no authoritative outcome.
function referencesAuthoritative(replica, request) {
  const pending = request.slots.filter((slot) => slot.state === 'waiting' && slot.recipe.kind === 'restore')
    .flatMap((slot) => slot.recipe.operations.flatMap((op) => [op.reference, op.reference?.recordBirth]))
    .filter((reference) => reference?.kind === 'pending');
  return pending.every(({ localId }) => {
    const entry = replica.entry(localId);
    return !entry || (entry.state === 'acked' && entry.resultEpoch === replica.meta.serverEpoch);
  });
}

// The version a reference binds to now, or null: an accepted version of this epoch (a reference taken before
// any epoch binds to the first), the version a pending entry's receipt accepted for it, or an absence in the
// incarnation its birth names.
function expectedOf(replica, reference) {
  const epoch = replica.meta.serverEpoch;
  if (reference.kind === 'accepted') return (reference.epoch ?? epoch) === epoch ? reference.version : null;
  if (reference.kind === 'pending') {
    const entry = replica.entry(reference.localId);
    const effects = entry ? entry.acceptedEffects : sourceOf(replica, reference.localId)?.source.attempts
      .find((attempt) => attempt.outcome === 'ok' && attempt.epoch === epoch)?.acceptedEffects;
    const row = rowsOf(effects ?? [], reference.target).at(-1);
    return row?.slots.find(({ slot }) => sameSlot(slot, reference.target.slot))?.version ?? null;
  }
  if ((reference.epoch ?? epoch) !== epoch) return null;
  if (reference.recordBirth === null) return { kind: 'absent', born: null };
  const born = expectedOf(replica, reference.recordBirth);
  return born ? { kind: 'absent', born: born.stamp } : null;
}

// §7.5 step 1: references taken before the replica held an epoch belong to the epoch it then took, which an
// epoch change now leaves.
export function bindReferences(replica, epoch) {
  const bindOne = (reference) => {
    if (!reference || reference.kind === 'pending') return;
    if (reference.epoch === null) reference.epoch = epoch;
    bindOne(reference.recordBirth);
  };
  for (const cancellation of replica.cancellations) for (const unit of cancellation.units) bindOne(unit.restored);
  for (const request of replica.inverses) {
    for (const slot of request.slots) if (slot.recipe.kind === 'restore') for (const op of slot.recipe.operations) bindOne(op.reference);
  }
}

// The latest accepted version the act owns of a target, or null.
function latestOwned(history, target) {
  let version = null;
  for (const { effects } of history) {
    for (const row of rowsOf(effects, target)) {
      const found = row.slots.find(({ slot }) => sameSlot(slot, target.slot));
      if (found) version = found.version;
    }
  }
  return version;
}

// A record the act created, proven unchanged by its own receipts alone: its creation's complete footprint and
// each later own write continuing the row sequence, next.beforeRowSeq = previous.rowSeq. A gap, or history
// another epoch took, proves nothing.
function createdFootprint(history, record) {
  if (history.some(({ lost }) => lost)) return null;
  const rows = history.flatMap(({ effects }) => rowsOf(effects, record));
  if (rows.length === 0 || rows[0].beforeRowSeq !== null) return null;
  const footprint = new Map();
  let previous = null;
  for (const row of rows) {
    if (previous !== null && row.beforeRowSeq !== previous) return null;
    for (const item of row.slots) footprint.set(jcs(item.slot), structuredClone(item));
    previous = row.rowSeq;
  }
  const ordered = [...footprint.values()].sort((a, b) => (rank(a.slot) < rank(b.slot) ? -1 : 1));
  return { rowSeq: previous, footprint: ordered };
}

const rank = (slot) => `${{ born: 0, life: 1, field: 2, text: 3 }[slot.kind]}${slot.name ?? ''}`;

// A scope the act created, proven unchanged by its own receipts: created (beforeSeq null), then each next
// receipt of it starting where the last ended.
function createdScope(history, scope) {
  if (history.some(({ lost }) => lost)) return null;
  const effects = history.flatMap(({ effects }) => effects.filter((effect) => effect.scope === scope));
  if (effects.length === 0 || effects[0].beforeSeq !== null || effects[0].seq === null) return null;
  let seq = effects[0].seq;
  for (const effect of effects.slice(1)) {
    if (effect.beforeSeq !== seq) return null;
    seq = effect.seq;
  }
  return { scope, seq };
}

// Binds a waiting request's slots once its act's sources are authoritative: each restore operation takes the
// latest version the act owns, or goes; each product slot its evidence, or goes whole. Settlement only removes
// operations and projections; a slot left with nothing settles unnumbered.
export function materialize(replica, ctx, request) {
  if (request.state !== 'waiting') return;
  const act = replica.journal.find((candidate) => candidate.actId === request.sourceActId);
  if (act && !authoritative(replica, act)) return;
  if (!act && !referencesAuthoritative(replica, request)) return;
  const history = act ? ownedHistory(replica, act) : [];
  const epoch = replica.meta.serverEpoch;
  const bind = (op) => {
    if (op.kind === 'field') {
      const expected = op.reference ? expectedOf(replica, op.reference) : latestOwned(history, op.target);
      return expected && { kind: 'field', t: op.target.t, id: op.target.id, slot: op.target.slot, expected, before: op.before };
    }
    if (op.kind === 'createdRecord') {
      const proof = createdFootprint(history, op.record);
      return proof && { kind: 'createdRecord', t: op.record.t, id: op.record.id, ...proof };
    }
    return (op.reference.epoch ?? epoch) === epoch ? { kind: 'createRecord', t: op.record.t, id: op.record.id, values: op.values } : null;
  };
  for (const slot of request.slots) {
    const entry = replica.entry(slot.localId);
    if (!entry) {
      settleSlot(replica, slot, null, 'refused');
      continue;
    }
    const { recipe } = slot;
    let args = null;
    if (recipe.kind === 'restore' && epoch !== null) {
      const bound = recipe.operations.map((op) => ({ op, wire: bind(op) })).filter(({ wire }) => wire);
      recipe.operations = bound.map(({ op }) => op);
      if (bound.length) args = { expectedEpoch: epoch, operations: bound.map(({ wire }) => wire) };
    }
    if (recipe.kind === 'command' && epoch !== null) {
      const records = recipe.evidence.unchangedCreatedRecords.map((record) => ({ record, proof: createdFootprint(history, record) }));
      const scopes = recipe.evidence.unchangedCreatedScopes.map((scope) => createdScope(history, scope));
      if (records.every(({ proof }) => proof) && scopes.every(Boolean)) {
        args = { input: structuredClone(recipe.input), evidence: { expectedEpoch: epoch,
          ownedFields: recipe.evidence.ownedFields.flatMap((target) => {
            const version = latestOwned(history, target);
            return version ? [{ target: structuredClone(target), version }] : [];
          }),
          unchangedCreatedRecords: records.map(({ record, proof }) => ({ record: structuredClone(record), ...proof })),
          unchangedCreatedScopes: scopes } };
      }
    }
    if (args === null) {
      if (recipe.kind === 'restore') recipe.operations = [];
      moveEntry(replica, ctx.ended, entry, 'vacate');
      settleSlot(replica, slot, []);
      continue;
    }
    if (recipe.kind === 'restore') keepProjection(entry, recipe.operations);
    entry.intent.cmd.args = args;
    slot.state = 'materialized';
  }
  request.state = 'materialized';
  settleRequest(replica, request);
}

// The projection of the operations a slot still holds, the rest withdrawn.
function keepProjection(entry, operations) {
  for (const projection of entry.predictions) {
    projection.d = projection.d.flatMap((delta) => {
      const kept = operations.filter((op) => sameRecord(op.kind === 'field' ? op.target : op.record, { scope: projection.scope, t: delta.t, id: delta.id }));
      if (kept.length === 0) return [];
      if (kept.some((op) => op.kind === 'createRecord')) return [delta];
      const next = { t: delta.t, id: delta.id };
      if (delta.born !== undefined) next.born = delta.born;
      for (const op of kept) {
        if (op.kind === 'createdRecord' || op.target.slot.kind === 'life') next.life = delta.life;
        else if (op.target.slot.kind === 'field') next.f = { ...next.f, [op.target.slot.name]: delta.f[op.target.slot.name] };
        else next.x = { ...next.x, [op.target.slot.name]: delta.x[op.target.slot.name] };
      }
      return [next];
    });
  }
}

function settleSlot(replica, slot, outcomes, code) {
  const count = slot.recipe.kind === 'restore' ? slot.recipe.operations.length : 1;
  slot.outcomes = outcomes ?? Array.from({ length: count }, (_, index) => ({ index, s: 'skipped', code }));
  slot.state = 'settled';
}

// A request settles once every slot has: changed is whether any slot's accepted effects changed a row.
function settleRequest(replica, request) {
  if (request.state === 'settled' || request.slots.some((slot) => slot.state !== 'settled')) return;
  const outcomes = request.slots.flatMap((slot) => slot.outcomes);
  request.state = 'settled';
  request.result = { kind: 'settled', requestId: request.requestId, inverseActId: request.inverseActId,
    changed: request.slots.some((slot) => slot.changed === true),
    appliedCount: outcomes.filter(({ s }) => s === 'applied').length,
    skippedCount: outcomes.filter(({ s }) => s === 'skipped').length };
  collectJournal(replica);
}

// The sender's barrier (§7.4): an inverse slot not yet materialized is materialized now if it can be; one
// that still waits stops numbering. Answers whether the entry may be numbered.
export function passesBarrier(replica, ctx, entry) {
  const found = slotOf(replica, entry);
  if (!found || found.slot.state !== 'waiting') return true;
  materialize(replica, ctx, found.request);
  return found.slot.state !== 'waiting';
}

// An inverse entry's outcomes, checked before the ACK changes anything.
export function checkInverseResult(replica, entry, result) {
  const found = slotOf(replica, entry);
  if (!found || result.s !== 'ok') return;
  const count = found.slot.recipe.kind === 'restore' ? found.slot.recipe.operations.length : 1;
  inverseOutcomes(result.detail?.command, count);
}

// The result of an inverse entry, in its ACK or refusal transaction: its outcomes settle the slot, a skipped
// operation's projection is withdrawn, and the request settles with its last slot.
export function applyInverseResult(replica, entry, result) {
  const found = slotOf(replica, entry);
  if (!found) return;
  const { request, slot } = found;
  if (result.s === 'ok') {
    const outcomes = inverseOutcomes(result.detail?.command, slot.recipe.kind === 'restore' ? slot.recipe.operations.length : 1);
    if (slot.recipe.kind === 'restore') keepProjection(entry, slot.recipe.operations.filter((_, index) => outcomes[index].s === 'applied'));
    slot.changed = (entry.acceptedEffects ?? []).some(({ rows }) => rows.length > 0);
    settleSlot(replica, slot, structuredClone(outcomes));
  } else if (replica.entry(entry.localId) !== entry) {
    settleSlot(replica, slot, null, result.code);
  }
  settleRequest(replica, request);
}

// The slots whose entries ended without a result (a fold, or a Discard) settle skipped by `code`. A Discard
// also withdraws their values: the slot keeps only its outcomes.
export function settleEnded(replica, code, { withdraw = false } = {}) {
  for (const request of replica.inverses) {
    if (request.state === 'settled') continue;
    for (const slot of request.slots) {
      if (slot.state === 'settled' || replica.entry(slot.localId)) continue;
      settleSlot(replica, slot, null, code);
      if (withdraw) slot.recipe = { kind: 'withdrawn', command: slot.recipe.command };
    }
    settleRequest(replica, request);
  }
}

// readInverseResult(requestId): cancelled, pending, settled or unavailable.
export function readInverseResult(replica, requestId) {
  const request = requestOf(replica, requestId);
  if (!request) return { kind: 'unavailable', requestId, reason: 'unknown-request' };
  if (request.result) return structuredClone(request.result);
  return { kind: 'pending', requestId, inverseActId: request.inverseActId, localChanged: request.localChanged };
}
