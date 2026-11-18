// K-3 Undo and Redo of an act (§7.3 Undo of an act): an inverse request reserves its slots in the outbox at
// once, each an ordinary entry at the end of commit order that carries its optimistic projection and blocks
// the sender until it is materialized. Once every source of the act has an authoritative outcome, the slots
// bind the latest versions the act owns and its first preimages into restore or inverse commands, in one
// transaction; a slot left with nothing settles unnumbered. The inverse act journals its own preimages,
// so a Redo takes back only what the Undo actually applied.

import { Clock } from '../core/clock.js';
import { jcs, sameJson } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { inverseOutcomes, sameRecord, sameSlot, sameTarget, valueIn } from '../core/restore.js';
import { recordKey } from '../core/rows.js';
import { undo } from './hold.js';
import { collectJournal, ordinalOf } from './journal.js';
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
    const current = view.get(recordKey(address.t, address.id));
    if (!current) continue;
    const key = recordKey(address.t, address.id);
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
      const type = registry.type(op.record.t);
      return type.identity === 'keyed' || type.revivable ? [{ ...op.record, slot: { kind: 'life' } }] : [];
    });
    const preimages = targets.flatMap((target) => {
      const value = valueIn(view.get(recordKey(target.t, target.id)), target.slot);
      return value === undefined ? [] : [{ target: structuredClone(target), value: structuredClone(value) }];
    });
    const restorable = preimages.map(({ target }) => ({ target: structuredClone(target) }));
    return { localId, originScope: scope, recipes: restorable.length ? [{ kind: 'fields', restoreCommand: recipe.command, targets: restorable }] : [], preimages, attempts: [] };
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
  if (!act) return { kind: 'unavailable', requestId: null, reason: 'not-reversible' };
  const entries = replica.entries().filter((entry) => entry.gestureId === sourceActId);
  if (entries.length > 0 && entries.every((entry) => entry.state === 'held')) return cancelHeld(replica, ctx, act, entries);

  const planned = plannedSlots(act, replacement);
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
  const scopes = [...new Set(entries.flatMap((entry) => (entry.predictions ?? [{ scope: entry.scope }]).map(({ scope }) => scope)))];
  const before = new Map(scopes.map((scope) => [scope, drawn(replica, registry, scope)]));
  undo(replica, registry, ctx.ended, act.actId);
  const changed = scopes.some((scope) => !sameJson([...before.get(scope)], [...drawn(replica, registry, scope)]));
  const inverseActId = ctx.nextGestureId();
  const requestId = ctx.nextGestureId();
  replica.journal = replica.journal.filter((candidate) => candidate !== act);
  replica.inverses.push({ version: 1, requestId, sourceActId: act.actId, inverseActId, state: 'settled', slots: [],
    result: { kind: 'cancelled', requestId, inverseActId, changed } });
  return readInverseResult(replica, requestId);
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
  const history = act ? ownedHistory(replica, act) : [];
  const epoch = replica.meta.serverEpoch;
  for (const slot of request.slots) {
    const entry = replica.entry(slot.localId);
    if (!entry) {
      settleSlot(replica, slot, null, 'refused');
      continue;
    }
    const { recipe } = slot;
    let args = null;
    if (recipe.kind === 'restore' && epoch !== null) {
      recipe.operations = recipe.operations.filter((op) => (op.kind === 'field' ? latestOwned(history, op.target) : createdFootprint(history, op.record)) !== null);
      const operations = recipe.operations.map((op) => {
        if (op.kind === 'field') return { kind: 'field', t: op.target.t, id: op.target.id, slot: op.target.slot, expected: latestOwned(history, op.target), before: op.before };
        return { kind: 'createdRecord', t: op.record.t, id: op.record.id, ...createdFootprint(history, op.record) };
      });
      if (operations.length) args = { expectedEpoch: epoch, operations };
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
