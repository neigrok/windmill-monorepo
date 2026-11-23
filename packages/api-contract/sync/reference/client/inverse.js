// K-3 Undo and Redo of an act (§7.3 Undo of an act): an inverse request reserves its slots in the outbox at
// once, each an ordinary entry at the end of commit order that carries its optimistic projection and blocks
// the sender until it is materialized. Once every source of the act has an authoritative outcome, the slots
// bind the latest versions the act owns and its first preimages into restore or inverse commands, in one
// transaction; a slot left with nothing settles unnumbered. An Undo never erases a write the device had not
// seen when it acted. The inverse act journals the values the act wrote, so a Redo writes back exactly those,
// and only where its Undo applied.

import { Clock } from '../core/clock.js';
import { jcs, sameJson } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { compareSlots, creatableFault, inverseOutcomes, recipeFault, recordValues, restorableSlotFault, sameRecord, sameSlot, valueIn, versionIn } from '../core/restore.js';
import { recordKey } from '../core/rows.js';
import { CommitError } from './commit.js';
import { undo } from './hold.js';
import { ordinalOf, settleRequest, settleSlot } from './journal.js';
import { effectsOf } from './projections.js';
import { drawn } from './views.js';

function requestOf(replica, requestId) {
  return replica.inverses.find((request) => request.requestId === requestId);
}

// The slot an inverse entry reserved, with its request.
function slotOf(replica, entry) {
  const request = entry.inverseOf === undefined ? undefined : requestOf(replica, entry.inverseOf);
  const slot = request?.slots.find((candidate) => candidate.localId === entry.localId);
  return slot ? { request, slot } : null;
}

const addressOf = (op) => (op.kind === 'field' ? op.target : op.record);

// A slot's planned recipe, from the act's own recipes: one restore slot a source entry for its generic recipes,
// a target restored once from its first preimage, a revived life with the record that preimage read, and one slot
// each product command recipe. Undo runs the act backwards: the last source's slots come first.
function plannedSlots(sources) {
  const named = new Set();
  const firstOf = new Map();
  for (const source of sources) {
    for (const preimage of source.preimages) if (!firstOf.has(jcs(preimage.target))) firstOf.set(jcs(preimage.target), preimage);
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
      else {
        for (const { target } of recipe.targets) {
          const { value, record } = firstOf.get(jcs(target));
          operations.push({ kind: 'field', target: structuredClone(target), before: structuredClone(value), ...(record ? { record: structuredClone(record) } : {}) });
        }
      }
    }
    const unique = operations.filter((op) => {
      const key = jcs(addressOf(op));
      if (named.has(key)) return false;
      named.add(key);
      return true;
    });
    if (unique.length) slots.push({ scope: source.originScope, recipe: { kind: 'restore', command, operations: unique } });
  }
  return slots;
}

// The stored recipes, or a complete replacement by source ordinal, each checked against its source's scope; a
// replacement's field target needs a first preimage the act journaled, so a cancellation's has none.
function sourcesOf(registry, sourceEntries, replacement) {
  if (!replacement) return sourceEntries;
  const ordinals = sourceEntries.map(({ localId }) => ordinalOf(localId));
  if (!Array.isArray(replacement) || replacement.some((item) => !ordinals.includes(item?.index) || !Array.isArray(item.recipes))
    || new Set(replacement.map(({ index }) => index)).size !== replacement.length) throw new CommitError('inverse slots name sources by ordinal, once each');
  return sourceEntries.map((source) => {
    const recipes = structuredClone(replacement.find((item) => item.index === ordinalOf(source.localId))?.recipes ?? []);
    for (const recipe of recipes) {
      const fault = recipeFault(registry, source.originScope, recipe)
        ?? (recipe.kind === 'fields' && recipe.targets.some(({ target }) => !source.preimages.some((preimage) => sameJson(preimage.target, target)))
          ? 'an inverse slot restores only a target its act journaled' : null);
      if (fault) throw new CommitError(`an inverse slot recipe is malformed: ${fault}`);
    }
    return { ...source, recipes };
  });
}

// The optimistic projection of a restore slot over `view`, at `stamp`: each operation as the restore would
// write it, one delta a record. A record the view lacks is drawn only where a life operation revives it, with
// the values its preimage read; any other operation on it projects nothing.
function projectionOf(registry, view, operations, stamp) {
  const deltas = new Map();
  const revived = new Map(operations.filter((op) => op.kind === 'field' && op.target.slot.kind === 'life' && op.record)
    .map((op) => [recordKey(op.target.t, op.target.id), { t: op.target.t, id: op.target.id, ...op.record }]));
  for (const op of operations) {
    const address = addressOf(op);
    const key = recordKey(address.t, address.id);
    if (op.kind === 'createRecord') {
      if (view.has(key)) continue;
      const created = { t: address.t, id: address.id, life: ['alive', stamp], ...(registry.type(address.t).hasBorn ? { born: stamp } : {}) };
      if (Object.keys(op.values.f ?? {}).length) created.f = Object.fromEntries(Object.entries(op.values.f).map(([name, value]) => [name, [value, stamp]]));
      if (Object.keys(op.values.x ?? {}).length) created.x = Object.fromEntries(Object.entries(op.values.x).map(([name, text]) => [name, { text, base: { text: '' } }]));
      deltas.set(key, created);
      continue;
    }
    const absent = !view.has(key);
    const current = view.get(key) ?? revived.get(key);
    if (!current) continue;
    const delta = deltas.get(key) ?? { t: address.t, id: address.id, ...(registry.type(address.t).hasBorn ? { born: current.born } : {}),
      ...(absent && current.f ? { f: structuredClone(current.f) } : {}),
      ...(absent && current.x ? { x: Object.fromEntries(Object.entries(current.x).map(([name, text]) => [name, { text, base: { text: '' } }])) } : {}) };
    deltas.set(key, delta);
    if (op.kind === 'createdRecord') delta.life = ['dead', stamp];
    else if (op.target.slot.kind === 'life') delta.life = [op.before, stamp];
    else if (op.target.slot.kind === 'field') delta.f = { ...delta.f, [op.target.slot.name]: [op.before, stamp] };
    else delta.x = { ...delta.x, [op.target.slot.name]: { text: op.before, base: { text: valueIn(current, op.target.slot) ?? '' } } };
  }
  return [...deltas.values()];
}

// The inverse act's own journal: each restore slot a source whose recipes put back what the inverse replaces,
// the values the inverted act wrote (`forward`), never what a later local edit shows. A created record comes
// back by its life only where a write can bring it back, with the record as `before` drew it, and one the
// inverse creates goes again by its strict recipe; a product slot has no generic recipe, and its Redo is the
// product's. A preimage's row sequence is the row its restore wrote over, which the restore's version check
// proved held it (`anchorPreimages`).
function inverseJournal(registry, inverseActId, slots, forward, before) {
  const sourceEntries = slots.map(({ localId, scope, recipe }) => {
    const empty = { localId, originScope: scope, recipes: [], preimages: [], written: [], attempts: [] };
    if (recipe.kind !== 'restore') return empty;
    const preimages = [];
    const written = [];
    const recreated = [];
    for (const op of recipe.operations) {
      if (op.kind === 'createRecord') {
        recreated.push({ kind: 'createdRecord', restoreCommand: recipe.command, record: structuredClone(op.record) });
        continue;
      }
      const type = registry.type(addressOf(op).t);
      if (op.kind === 'createdRecord' && type.identity !== 'keyed' && !type.revivable) continue;
      const target = op.kind === 'field' ? structuredClone(op.target) : { ...structuredClone(op.record), slot: { kind: 'life' } };
      const value = op.kind === 'field' ? forward.get(jcs(target)) : 'alive';
      if (value === undefined) continue;
      const drew = op.kind === 'createdRecord' ? before.get(scope).get(recordKey(target.t, target.id)) : undefined;
      preimages.push({ target, value: structuredClone(value), rowSeq: null, epoch: null, ...(drew ? { record: recordValues(drew) } : {}) });
      written.push({ target: structuredClone(target), value: op.kind === 'field' ? structuredClone(op.before) : 'dead' });
    }
    const recipes = [...(preimages.length ? [{ kind: 'fields', restoreCommand: recipe.command, targets: preimages.map(({ target }) => ({ target: structuredClone(target) })) }] : []), ...recreated];
    return { ...empty, recipes, preimages, written };
  });
  return { version: 1, actId: inverseActId, retained: true, sourceEntries };
}

// The value an act left in each target, its last source's.
function forwardOfAct(act) {
  const forward = new Map();
  for (const source of [...act.sourceEntries].sort((a, b) => ordinalOf(a.localId) - ordinalOf(b.localId))) {
    for (const { target, value } of source.written ?? []) forward.set(jcs(target), value);
  }
  return forward;
}

// The value each target showed once a cancellation took the act out, which an Undo of its Redo puts back.
function forwardOfCancellation(cancellation) {
  return new Map(cancellation.units.filter((unit) => unit.kind === 'field' && unit.restoredValue !== undefined)
    .map((unit) => [jcs(unit.target), unit.restoredValue]));
}

// requestInverse(sourceActId, inverseSlots?): Undo of an opted act, or Redo of an inverse act or a cancellation.
// An act whose entries are all still held is cancelled at once, as `undo` cancels it. Otherwise the slots are
// reserved, projected and, where every source is already authoritative, materialized, all in this transaction.
// `replacement`, a complete list [{index, recipes}] by source ordinal, stands in for the stored recipes. A
// cancelled product command has no generic Redo: its Redo needs the product's replacement.
export function requestInverse(replica, ctx, sourceActId, replacement) {
  const { registry } = ctx;
  const existing = replica.inverses.find((request) => request.sourceActId === sourceActId);
  if (existing) return readInverseResult(replica, existing.requestId);
  const act = replica.journal.find((candidate) => candidate.actId === sourceActId);
  const cancellation = replica.cancellations.find((candidate) => candidate.inverseActId === sourceActId);
  if (!act && !cancellation) return { kind: 'unavailable', requestId: null, reason: 'not-reversible' };
  const entries = replica.entries().filter((entry) => entry.gestureId === sourceActId);
  if (act && entries.length > 0 && entries.every((entry) => entry.state === 'held')) return cancelHeld(replica, ctx, act, entries);
  if (cancellation && !replacement && cancellation.sourceEntries.some((source) => source.command)) {
    return { kind: 'unavailable', requestId: null, reason: 'product-redo-required' };
  }

  const planned = act ? plannedSlots(sourcesOf(registry, act.sourceEntries, replacement))
    : replacement ? plannedSlots(sourcesOf(registry, cancellation.sourceEntries.map((source) => ({ ...source, preimages: [] })), replacement))
      : redoSlots(registry, cancellation);
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
  const journal = inverseJournal(registry, inverseActId, slots, act ? forwardOfAct(act) : forwardOfCancellation(cancellation), before);
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
  const localChanged = [...touched.values()].some(({ scope, key }) => !sameJson(before.get(scope).get(key) ?? null, drawn(replica, registry, scope).get(key) ?? null));
  replica.inverses.push({ version: 1, requestId, sourceActId, inverseActId, state: 'waiting', requestedAt: ctx.deviceNow, localChanged,
    slots: slots.map(({ localId, commitOrder, scope, recipe, state }) => ({ localId, commitOrder, originScope: scope, recipe, state })) });
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
  const ordinary = (entry) => entry.intent.cmd === undefined || registry.command(entry.intent.cmd.name)?.engine === 'capture';
  const scopes = [...new Set(entries.flatMap((entry) => effectsOf(entry).map(({ scope }) => scope)))];
  const before = new Map(scopes.map((scope) => [scope, drawn(replica, registry, scope)]));
  const written = entries.filter(ordinary).flatMap((entry) => (entry.intent.d ?? []).map((delta) => ({ entry, scope: entry.scope, delta })));
  undo(replica, registry, ctx.ended, act.actId);
  const after = new Map(scopes.map((scope) => [scope, drawn(replica, registry, scope)]));
  const changed = scopes.some((scope) => !sameJson([...before.get(scope)], [...after.get(scope)]));
  const inverseActId = ctx.nextGestureId();
  const requestId = ctx.nextGestureId();
  replica.journal = replica.journal.filter((candidate) => candidate !== act);
  replica.cancellations.push({ version: 1, inverseActId, cancelledActId: act.actId,
    sourceEntries: entries.map((entry) => ({ localId: entry.localId, originScope: entry.scope, ...(ordinary(entry) ? {} : { command: true }) })),
    units: cancellationUnits(replica, registry, written, before, after) });
  replica.inverses.push({ version: 1, requestId, sourceActId: act.actId, inverseActId, state: 'settled', requestedAt: ctx.deviceNow, slots: [],
    result: { kind: 'cancelled', requestId, inverseActId, changed } });
  return readInverseResult(replica, requestId);
}

// The changes a cancellation actually took out of `drawn`, from the act's ordinary deltas (a product command's
// effects are its own, never generic), each with what restoring it must find: a register the act wrote that
// now reads otherwise, at the version it now reads (accepted, a pending entry's, or absent in the record's
// incarnation) with the value it now reads, and a record it created that is now absent, with the act's own
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
      for (const [name, [value]] of Object.entries(delta.f ?? {})) if (type.field(name)?.writer === 'client') (unit.redoValues.f ??= {})[name] = structuredClone(value);
      for (const [name, write] of Object.entries(delta.x ?? {})) if (type.field(name)?.writer === 'client') (unit.redoValues.x ??= {})[name] = write.text;
      units.set(jcs(['record', record]), unit);
      continue;
    }
    const slots = [...(delta.life ? [{ kind: 'life' }] : []), ...Object.keys(delta.f ?? {}).map((name) => ({ kind: 'field', name })),
      ...Object.keys(delta.x ?? {}).map((name) => ({ kind: 'text', name }))];
    for (const slot of slots) {
      if (restorableSlotFault(type, slot) || sameJson(valueIn(was, slot) ?? null, valueIn(now, slot) ?? null)) continue;
      const target = { ...record, slot };
      const restoredValue = valueIn(now, slot);
      units.set(jcs(['field', target]), { kind: 'field', ownerLocalId: entry.localId, target, redoValue: structuredClone(valueIn(was, slot)),
        restored: referenceOf(replica, registry, target, now), ...(restoredValue === undefined ? {} : { restoredValue: structuredClone(restoredValue) }) });
    }
  }
  return [...units.values()];
}

// Where the value a target reads now comes from: an entry that wrote it (pending until its ACK, then the version
// it wrote), the confirmed row's accepted version, or, unset, the record's birth.
function referenceOf(replica, registry, target, now) {
  const epoch = replica.meta.serverEpoch;
  const writer = (slot) => replica.entries().reverse().find((entry) => effectsOf(entry, { active: true })
    .some(({ scope, d }) => scope === target.scope && d.some((delta) => delta.t === target.t && sameJson(delta.id, target.id) && writes(delta, slot, now))));
  const pendingOf = (slot) => {
    const entry = writer(slot);
    if (!entry) return null;
    const pending = { kind: 'pending', localId: entry.localId, target: { ...target, slot } };
    return entry.state === 'acked' ? boundTo(pending, entry, entry.resultEpoch) : pending;
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

const currentEffects = (replica, source) => source.attempts.find((attempt) => attempt.outcome === 'ok' && attempt.epoch === replica.meta.serverEpoch)?.acceptedEffects ?? [];

// The accepted receipts the act's sources own in the current epoch, in commit order; a source whose history
// another epoch took is `lost`.
function ownedHistory(replica, act) {
  return [...act.sourceEntries].sort((a, b) => ordinalOf(a.localId) - ordinalOf(b.localId))
    .map((source) => ({ lost: source.unavailable === true, effects: currentEffects(replica, source) }));
}

const rowsOf = (effects, address) => effects.filter(({ scope }) => scope === address.scope)
  .flatMap(({ rows }) => rows.filter((row) => row.t === address.t && sameJson(row.id, address.id)));

// A Redo of a cancellation waits while an entry its references name has no result yet.
function referencesAuthoritative(replica, request) {
  const pending = request.slots.filter((slot) => slot.state === 'waiting' && slot.recipe.kind === 'restore')
    .flatMap((slot) => slot.recipe.operations.flatMap((op) => [op.reference, op.reference?.recordBirth]))
    .filter((reference) => reference?.kind === 'pending');
  return pending.every(({ localId }) => !replica.entry(localId));
}

// The version a reference binds to now, or null: an accepted version of this epoch (a reference taken before
// any epoch binds to the first), or an absence in the incarnation its birth names. A pending reference binds at
// its entry's result (`resolveReferences`); one whose entry ended without one binds nothing.
function expectedOf(replica, reference) {
  const epoch = replica.meta.serverEpoch;
  if (reference.kind === 'accepted') return (reference.epoch ?? epoch) === epoch ? reference.version : null;
  if (reference.kind !== 'fieldAbsent' || (reference.epoch ?? epoch) !== epoch) return null;
  if (reference.recordBirth === null) return { kind: 'absent', born: null };
  const born = expectedOf(replica, reference.recordBirth);
  return born ? { kind: 'absent', born: born.stamp } : null;
}

// The result of an entry a cancellation's references wait on, in its ACK transaction: each reference to it binds
// the version it wrote (`boundTo`).
export function resolveReferences(replica, entry, epoch) {
  const resolve = (reference) => {
    if (!reference) return reference;
    if (reference.kind === 'fieldAbsent') return { ...reference, recordBirth: resolve(reference.recordBirth) };
    if (reference.kind !== 'pending' || reference.localId !== entry.localId) return reference;
    return boundTo(reference, entry, epoch);
  };
  for (const cancellation of replica.cancellations) for (const unit of cancellation.units) unit.restored = resolve(unit.restored);
  for (const request of replica.inverses) {
    for (const slot of request.slots) {
      if (slot.state !== 'waiting' || slot.recipe.kind !== 'restore') continue;
      for (const op of slot.recipe.operations) if (op.reference) op.reference = resolve(op.reference);
    }
  }
}

// A pending reference bound to the version its acknowledged entry wrote, in `epoch`: from the entry's receipt,
// or, for an ordinary entry, its own delta's stamp, which the restore's condition then checks. A text without
// a receipt, or a register the entry did not write, binds nothing.
function boundTo(reference, entry, epoch) {
  const { target } = reference;
  if (entry.acceptedEffects) {
    const version = rowsOf(entry.acceptedEffects, target).at(-1)?.slots.find(({ slot }) => sameSlot(slot, target.slot))?.version;
    return version ? { kind: 'accepted', epoch, version } : { kind: 'unbound' };
  }
  if (target.scope !== entry.scope || target.slot.kind === 'text') return { kind: 'unbound' };
  const delta = (entry.intent.d ?? []).find((candidate) => candidate.t === target.t && sameJson(candidate.id, target.id));
  const stamp = target.slot.kind === 'born' ? delta?.born : target.slot.kind === 'life' ? delta?.life?.[1] : delta?.f?.[target.slot.name]?.[1];
  return stamp === undefined ? { kind: 'unbound' } : { kind: 'accepted', epoch, version: { kind: 'stamp', stamp } };
}

// §7.5 step 1: references and preimages taken before the replica held an epoch belong to the epoch it then
// took, which an epoch change now leaves.
export function bindReferences(replica, epoch) {
  const bindOne = (reference) => {
    if (!reference || reference.kind === 'pending' || reference.kind === 'unbound') return;
    if (reference.epoch === null) reference.epoch = epoch;
    bindOne(reference.recordBirth);
  };
  for (const cancellation of replica.cancellations) for (const unit of cancellation.units) bindOne(unit.restored);
  for (const request of replica.inverses) {
    for (const slot of request.slots) if (slot.recipe.kind === 'restore') for (const op of slot.recipe.operations) bindOne(op.reference);
  }
  for (const preimage of replica.journal.flatMap((act) => act.sourceEntries.flatMap((source) => source.preimages))) preimage.epoch ??= epoch;
}

// The act's own receipt rows of a record, in commit order.
const historyRows = (history, address) => history.flatMap(({ effects }) => rowsOf(effects, address));

// The latest accepted version the act owns of a target, or null.
function latestOwned(history, target) {
  let version = null;
  for (const row of historyRows(history, target)) {
    const found = row.slots.find(({ slot }) => sameSlot(slot, target.slot));
    if (found) version = found.version;
  }
  return version;
}

// Whether nothing but this device's own receipted writes came between the row sequence a preimage was read over
// and the act's last write of the record: following the journal's receipts from that sequence, each next row
// starting where the last ended, reaches the act's last row. A write the device had not seen breaks the walk.
function unbroken(replica, history, address, fromRowSeq) {
  const last = historyRows(history, address).at(-1);
  const own = replica.journal.flatMap((act) => act.sourceEntries.flatMap((source) => rowsOf(currentEffects(replica, source), address)));
  let at = fromRowSeq;
  for (;;) {
    if (at === last.rowSeq) return true;
    const next = own.filter((row) => row.beforeRowSeq === at && (at === null || row.rowSeq > at)).sort((a, b) => a.rowSeq - b.rowSeq)[0];
    if (!next) return false;
    at = next.rowSeq;
  }
}

// A record the act created, proven unchanged by its own receipts alone: its creation's complete footprint and
// each later own write continuing the row sequence, next.beforeRowSeq = previous.rowSeq. Null when the act never
// wrote it; `broken` when a gap, or history another epoch took, proves nothing.
function createdFootprint(history, record) {
  const rows = historyRows(history, record);
  if (rows.length === 0) return null;
  if (history.some(({ lost }) => lost) || rows[0].beforeRowSeq !== null) return { broken: true };
  const footprint = new Map();
  let previous = null;
  for (const row of rows) {
    if (previous !== null && row.beforeRowSeq !== previous) return { broken: true };
    for (const item of row.slots) footprint.set(jcs(item.slot), structuredClone(item));
    previous = row.rowSeq;
  }
  return { rowSeq: previous, footprint: [...footprint.values()].sort((a, b) => compareSlots(a.slot, b.slot)) };
}

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

// What one planned restore operation becomes: its wire form, a skip by `code` the request counts, or nothing
// (`null`) where the act never wrote the target, so there is nothing to take back. Where a source's history is
// unavailable, an unowned target may be one it wrote, and skips.
function bound(replica, act, history, op) {
  const epoch = replica.meta.serverEpoch;
  if (op.kind === 'field' && op.reference) {
    const expected = expectedOf(replica, op.reference);
    return expected ? { wire: { kind: 'field', t: op.target.t, id: op.target.id, slot: op.target.slot, expected, before: op.before } } : { skip: 'reference-unbound' };
  }
  if (op.kind === 'field') {
    const expected = latestOwned(history, op.target);
    if (!expected) return history.some(({ lost }) => lost) ? { skip: 'history-changed' } : null;
    const preimage = act.sourceEntries.flatMap((source) => source.preimages).find(({ target }) => sameJson(target, op.target));
    if ((preimage?.epoch ?? epoch) !== epoch) return { skip: 'epoch-changed' };
    if (!preimage || !unbroken(replica, history, op.target, preimage.rowSeq)) return { skip: 'history-changed' };
    return { wire: { kind: 'field', t: op.target.t, id: op.target.id, slot: op.target.slot, expected, before: op.before } };
  }
  if (op.kind === 'createdRecord') {
    const proof = createdFootprint(history, op.record);
    if (!proof) return null;
    return proof.broken ? { skip: 'history-changed' } : { wire: { kind: 'createdRecord', t: op.record.t, id: op.record.id, ...proof } };
  }
  return (op.reference.epoch ?? epoch) === epoch ? { wire: { kind: 'createRecord', t: op.record.t, id: op.record.id, values: op.values } } : { skip: 'epoch-changed' };
}

// Binds a waiting request's slots once its sources are authoritative: each restore operation takes the latest
// version the act owns where nothing the device had not seen came between, or skips, or goes; each product slot
// its evidence, or skips whole. Settlement only removes operations and projections; a slot left with nothing to
// send settles unnumbered.
export function materialize(replica, ctx, request) {
  if (request.state !== 'waiting') return;
  const act = replica.journal.find((candidate) => candidate.actId === request.sourceActId);
  if (act && !authoritative(replica, act)) return;
  if (!act && !referencesAuthoritative(replica, request)) return;
  const source = act ?? { sourceEntries: [] };
  const history = ownedHistory(replica, source);
  const epoch = replica.meta.serverEpoch;
  for (const slot of request.slots) {
    const entry = replica.entry(slot.localId);
    if (!entry) {
      settleSlot(replica, slot, null, 'refused');
      continue;
    }
    const { recipe } = slot;
    let args = null;
    const recorded = slot.skipped ?? [];
    slot.skipped = recorded;
    if (recipe.kind === 'restore' && epoch !== null) {
      const results = recipe.operations.map((op) => ({ op, result: bound(replica, source, history, op) }));
      slot.skipped = [...recorded, ...results.filter(({ result }) => result?.skip).map(({ result }) => ({ code: result.skip }))];
      const sent = results.filter(({ result }) => result?.wire);
      recipe.operations = sent.map(({ op }) => op);
      if (sent.length) args = { expectedEpoch: epoch, operations: sent.map(({ result }) => result.wire) };
    }
    if (recipe.kind === 'command' && epoch !== null) {
      const records = recipe.evidence.unchangedCreatedRecords.map((record) => ({ record, proof: createdFootprint(history, record) }));
      const scopes = recipe.evidence.unchangedCreatedScopes.map((scope) => createdScope(history, scope));
      if (records.every(({ proof }) => proof && !proof.broken) && scopes.every(Boolean)) {
        args = { input: structuredClone(recipe.input), evidence: { expectedEpoch: epoch,
          ownedFields: recipe.evidence.ownedFields.flatMap((target) => {
            const version = latestOwned(history, target);
            return version ? [{ target: structuredClone(target), version }] : [];
          }),
          unchangedCreatedRecords: records.map(({ record, proof }) => ({ record: structuredClone(record), ...proof })),
          unchangedCreatedScopes: scopes } };
      } else slot.skipped = [...recorded, { code: 'history-changed' }];
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
      const kept = operations.filter((op) => sameRecord(addressOf(op), { scope: projection.scope, t: delta.t, id: delta.id }));
      if (kept.length === 0) return [];
      if (kept.some((op) => op.kind === 'createRecord')) return [delta];
      const next = { t: delta.t, id: delta.id };
      if (delta.born !== undefined) next.born = delta.born;
      for (const op of kept) {
        if (op.kind === 'field' && op.record) Object.assign(next, delta.f ? { f: { ...delta.f, ...next.f } } : {}, delta.x ? { x: { ...delta.x, ...next.x } } : {});
        if (op.kind === 'createdRecord' || op.target.slot.kind === 'life') next.life = delta.life;
        else if (op.target.slot.kind === 'field') next.f = { ...next.f, [op.target.slot.name]: delta.f[op.target.slot.name] };
        else next.x = { ...next.x, [op.target.slot.name]: delta.x[op.target.slot.name] };
      }
      return [next];
    });
  }
}

// The sender's barrier (§7.4): an inverse slot not yet materialized is materialized now if it can be; one
// that still waits stops numbering. Answers whether the entry may be numbered.
export function passesBarrier(replica, ctx, entry) {
  const found = slotOf(replica, entry);
  if (!found || found.slot.state !== 'waiting') return true;
  materialize(replica, ctx, found.request);
  return found.slot.state !== 'waiting';
}

// An inverse entry's outcomes, checked before the ACK changes anything; throws when they are malformed.
export function checkInverseResult(replica, entry, result) {
  const found = slotOf(replica, entry);
  if (!found || found.slot.state === 'settled' || result.s !== 'ok') return;
  const count = found.slot.recipe.kind === 'restore' ? found.slot.recipe.operations.length : 1;
  inverseOutcomes(result.detail?.command, count);
}

// The result of an inverse entry, in its ACK or refusal transaction: its outcomes settle the slot, a skipped
// operation's projection is withdrawn, and the request settles with its last slot.
export function applyInverseResult(replica, entry, result, epoch) {
  const found = slotOf(replica, entry);
  if (!found) return;
  const { request, slot } = found;
  if (slot.state === 'settled') return;
  if (result.s === 'ok') {
    const outcomes = inverseOutcomes(result.detail?.command, slot.recipe.kind === 'restore' ? slot.recipe.operations.length : 1);
    if (slot.recipe.kind === 'restore') keepProjection(entry, slot.recipe.operations.filter((_, index) => outcomes[index].s === 'applied'));
    anchorPreimages(replica, request, entry, epoch);
    slot.changed = (entry.acceptedEffects ?? []).some(({ rows }) => rows.length > 0);
    settleSlot(replica, slot, structuredClone(outcomes));
  } else if (replica.entry(entry.localId) !== entry) {
    settleSlot(replica, slot, null, result.code);
  }
  settleRequest(replica, request);
}

// An applied restore wrote each record over the row whose version it checked: the inverse act's preimages there
// were read at that row, in the answer's epoch.
function anchorPreimages(replica, request, entry, epoch) {
  const source = replica.journal.find(({ actId }) => actId === request.inverseActId)?.sourceEntries.find(({ localId }) => localId === entry.localId);
  for (const preimage of source?.preimages ?? []) {
    const row = rowsOf(entry.acceptedEffects ?? [], preimage.target)[0];
    if (row) Object.assign(preimage, { rowSeq: row.beforeRowSeq, epoch });
  }
}

// §7.10 Add: an act adopted from `from` never read `into`'s own writes, which reach the server before its own. Each
// adopted act gives up every field target whose record `into` holds a write of, an outbox entry whose stored effects
// write it or a receipt row its journal keeps: the target leaves its recipes, preimages and written values, and a waiting
// request withdraws its operation there, counted skipped `history-changed`. A created record and a command recipe stay,
// proven by the act's own receipts alone. Answers how many targets the adopted acts gave up.
export function giveUpUnread(into, from) {
  const written = new Set();
  const note = (scope, t, id) => written.add(jcs([scope, t, id]));
  for (const entry of into.entries()) for (const { scope, d } of effectsOf(entry)) for (const delta of d) note(scope, delta.t, delta.id);
  for (const source of into.journal.flatMap((act) => act.sourceEntries)) {
    for (const effect of source.attempts.flatMap((attempt) => attempt.acceptedEffects ?? [])) for (const row of effect.rows) note(effect.scope, row.t, row.id);
  }
  const unread = ({ scope, t, id }) => written.has(jcs([scope, t, id]));
  let given = 0;
  for (const source of from.journal.flatMap((act) => act.sourceEntries)) {
    source.recipes = source.recipes.flatMap((recipe) => {
      if (recipe.kind !== 'fields') return [recipe];
      const targets = recipe.targets.filter(({ target }) => !unread(target));
      given += recipe.targets.length - targets.length;
      return targets.length ? [{ ...recipe, targets }] : [];
    });
    source.preimages = source.preimages.filter(({ target }) => !unread(target));
    source.written = (source.written ?? []).filter(({ target }) => !unread(target));
  }
  for (const request of from.inverses.filter(({ state }) => state === 'waiting')) {
    for (const slot of request.slots.filter((candidate) => candidate.state === 'waiting' && candidate.recipe.kind === 'restore')) {
      const kept = slot.recipe.operations.filter((op) => op.kind !== 'field' || op.reference || !unread(op.target));
      const withdrawn = slot.recipe.operations.length - kept.length;
      if (withdrawn === 0) continue;
      slot.recipe.operations = kept;
      slot.skipped = [...(slot.skipped ?? []), ...Array.from({ length: withdrawn }, () => ({ code: 'history-changed' }))];
      keepProjection(from.entry(slot.localId), kept);
    }
  }
  return given;
}

// readInverseResult(requestId): cancelled, pending, settled or unavailable.
export function readInverseResult(replica, requestId) {
  const request = requestOf(replica, requestId);
  if (!request) return { kind: 'unavailable', requestId, reason: 'unknown-request' };
  if (request.result) return structuredClone(request.result);
  return { kind: 'pending', requestId, inverseActId: request.inverseActId, localChanged: request.localChanged };
}
