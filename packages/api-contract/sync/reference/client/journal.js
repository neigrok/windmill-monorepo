// K-3 the journal of reversible acts (§7.3 Undo of an act): each act's source entries with their recipes,
// first local preimages, the values the act wrote and the receipts or refusals their ACK transactions record,
// beside the inverse requests and cancellation receipts that read them; their retention, epochs, lifecycle and
// settlement. The journal is the replica's local user data: values and ids never leave it but in a restore's
// own arguments.

import { moveEntry } from '../core/machines.js';

// The local id's ordinal: its position in its act's commit order.
export function ordinalOf(localId) {
  return Number(localId.slice(localId.lastIndexOf('/') + 1));
}

export function sourceOf(replica, localId) {
  for (const act of replica.journal) {
    const source = act.sourceEntries.find((candidate) => candidate.localId === localId);
    if (source) return { act, source };
  }
  return null;
}

// The ACK transaction's retention point (§7.4): a source keeps its accepted receipt, or its refusal, under the
// answer's epoch, before its entry can settle or be collected. One attempt an epoch: a replay's replaces it. An
// `ok` without a readable receipt proves nothing of what the act wrote: the source's history is `unavailable`.
export function retainOutcome(replica, localId, { epoch, n, outcome, acceptedEffects }) {
  const found = sourceOf(replica, localId);
  if (!found) return;
  const { source } = found;
  source.attempts = source.attempts.filter((attempt) => attempt.epoch !== epoch);
  source.attempts.push({ epoch, n, outcome, ...(acceptedEffects ? { acceptedEffects: structuredClone(acceptedEffects) } : {}) });
  if (outcome === 'ok' && !acceptedEffects) source.unavailable = true;
}

// §7.5 step 1: a restored server invalidates each source's proofs from another epoch. A source still in the
// outbox replays and earns its own; a collected one has none left, and its history is `unavailable`.
export function invalidateEpochs(replica, epoch) {
  for (const act of replica.journal) {
    for (const source of act.sourceEntries) {
      const lost = !replica.entry(source.localId) && source.attempts.some((attempt) => attempt.outcome === 'ok' && attempt.epoch !== epoch);
      source.attempts = source.attempts.filter((attempt) => attempt.epoch === epoch);
      if (lost) source.unavailable = true;
    }
  }
}

// §7.10: a Discard of a product's work removes the journal's whole source entries of that product, values
// included, and its cancellations' units and inverse requests; a record left with nothing of its own goes. The
// discarded slots settle skipped first.
export function discardJournal(replica, registry, product) {
  const theirs = (scope) => registry.productOfRef(scope) === product;
  for (const act of replica.journal) act.sourceEntries = act.sourceEntries.filter((source) => !theirs(source.originScope));
  replica.journal = replica.journal.filter((act) => act.sourceEntries.length > 0);
  settleEnded(replica, 'discarded');
  for (const cancellation of replica.cancellations) {
    const kept = new Set(cancellation.sourceEntries.filter((source) => !theirs(source.originScope)).map(({ localId }) => localId));
    cancellation.sourceEntries = cancellation.sourceEntries.filter(({ localId }) => kept.has(localId));
    cancellation.units = cancellation.units.filter((unit) => kept.has(unit.ownerLocalId));
  }
  const gone = new Set(replica.cancellations.filter((cancellation) => cancellation.sourceEntries.length === 0).map(({ inverseActId }) => inverseActId));
  replica.cancellations = replica.cancellations.filter((cancellation) => !gone.has(cancellation.inverseActId));
  replica.inverses = replica.inverses.filter((request) => (request.slots.length
    ? request.slots.some((slot) => !theirs(slot.originScope)) : !gone.has(request.inverseActId)));
}

// §7.5 step 2: a scope that ends (its `gone` or `not-found`, or a dead governing row) keeps none of its values in
// the journal. Its sources keep their receipts and become unavailable; a cancellation's units there go; a slot
// still waiting there vacates, skipped.
export function forgetJournalScope(replica, ended, scope) {
  for (const act of replica.journal) {
    for (const source of act.sourceEntries) {
      if (source.originScope !== scope) continue;
      Object.assign(source, { recipes: [], preimages: [], written: [], unavailable: true });
    }
  }
  for (const cancellation of replica.cancellations) cancellation.units = cancellation.units.filter((unit) => (unit.target ?? unit.record).scope !== scope);
  for (const request of replica.inverses) {
    if (request.state === 'settled') continue;
    for (const slot of request.slots) {
      if (slot.state !== 'waiting' || slot.originScope !== scope) continue;
      const entry = replica.entry(slot.localId);
      if (entry) moveEntry(replica, ended, entry, 'vacate');
      settleSlot(replica, slot, null, 'scope-gone');
    }
    settleRequest(replica, request);
  }
}

// §7.3 engine start: no product stack outlives its process, so every act and cancellation no unsettled request
// reads goes.
export function releaseJournal(replica) {
  for (const act of replica.journal) act.retained = false;
  for (const cancellation of replica.cancellations) cancellation.retained = false;
  collectJournal(replica);
}

// Moves a replica's journal into another at an Add, keeping act and local ids.
export function adoptJournal(target, source) {
  target.journal.push(...source.journal);
  target.inverses.push(...source.inverses);
  target.cancellations.push(...source.cancellations);
}

// The product's stack no longer needs the act. Its record goes unless an unsettled inverse still reads it.
// A cancellation's receipt and a settled request whose inverse act this is go with it; what an unsettled
// request still reads stays.
export function releaseReversibleAct(replica, actId) {
  const act = replica.journal.find((candidate) => candidate.actId === actId);
  const cancellation = replica.cancellations.find((candidate) => candidate.inverseActId === actId);
  if (!act && !cancellation) return false;
  if (act) act.retained = false;
  if (cancellation) cancellation.retained = false;
  replica.inverses = replica.inverses.filter((request) => request.state !== 'settled' || request.inverseActId !== actId);
  collectJournal(replica);
  return true;
}

// The journal keeps acts the product's stack retains, acts an unsettled request inverts, and acts whose
// sources a kept cancellation's references wait on; cancellations stay while retained or redone.
export function collectJournal(replica) {
  const unsettled = replica.inverses.filter((request) => request.state !== 'settled').map((request) => request.sourceActId);
  replica.cancellations = replica.cancellations.filter((cancellation) => cancellation.retained !== false || unsettled.includes(cancellation.inverseActId));
  const referenced = new Set(replica.cancellations.flatMap((cancellation) => cancellation.units)
    .flatMap((unit) => [unit.restored, unit.restored?.recordBirth]).filter((reference) => reference?.kind === 'pending').map(({ localId }) => localId));
  replica.journal = replica.journal.filter((act) => act.retained || unsettled.includes(act.actId)
    || act.sourceEntries.some((source) => referenced.has(source.localId)));
}

// An inverse request's slot settles with its outcomes, or every operation skipped by `code`. A settled slot
// keeps no values: its recipe gives way to its command's name.
export function settleSlot(replica, slot, outcomes, code) {
  const count = slot.recipe.kind === 'restore' ? slot.recipe.operations.length : 1;
  slot.outcomes = outcomes ?? Array.from({ length: count }, (_, index) => ({ index, s: 'skipped', code }));
  slot.recipe = { kind: 'withdrawn', command: slot.recipe.command };
  slot.state = 'settled';
}

// A request settles once every slot has: changed is whether any slot's accepted effects changed a row, and the
// counts take every operation a slot sent and every one it skipped before sending.
export function settleRequest(replica, request) {
  if (request.state === 'settled' || request.slots.some((slot) => slot.state !== 'settled')) return;
  const outcomes = request.slots.flatMap((slot) => [...slot.outcomes, ...(slot.skipped ?? []).map(({ code }) => ({ s: 'skipped', code }))]);
  request.state = 'settled';
  request.result = { kind: 'settled', requestId: request.requestId, inverseActId: request.inverseActId,
    changed: request.slots.some((slot) => slot.changed === true),
    appliedCount: outcomes.filter(({ s }) => s === 'applied').length,
    skippedCount: outcomes.filter(({ s }) => s === 'skipped').length };
  collectJournal(replica);
}

// The slots whose entries ended without a result (a fold, or a Discard) settle skipped by `code`.
export function settleEnded(replica, code) {
  for (const request of replica.inverses) {
    if (request.state === 'settled') continue;
    for (const slot of request.slots) {
      if (slot.state === 'settled' || replica.entry(slot.localId)) continue;
      settleSlot(replica, slot, null, code);
    }
    settleRequest(replica, request);
  }
}

// §7.7 write map and E-8: the journal, its inverse requests and its cancellations follow the same logical map as
// the queue. Each record a holder names is renamed in the scope it names, and a command input in the scope its
// holder had, before that scope moves. A value recorded for a field (a preimage, a written value, a default, an
// operation's earlier value, a redo value, a revival's registers) is renamed as that record's field would be,
// so a typed reference it holds follows the map too.
export function remapJournal(registry, replica, map) {
  const { references } = registry;
  const registers = (address, f) => {
    const holder = { t: address.t, id: structuredClone(address.id), f: structuredClone(f) };
    references.remapRecord(address.scope, holder, map);
    return holder.f;
  };
  const valueOf = (address, value) => (address.slot.kind === 'field' ? registers(address, { [address.slot.name]: [value, null] })[address.slot.name][0] : value);
  const valuesOf = (address, values) => Object.fromEntries(Object.entries(registers(address,
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, [value, null]])))).map(([name, [value]]) => [name, value]));
  const target = (holder) => {
    references.remapRecord(holder.scope, holder, map);
    holder.scope = map.scope(holder.scope);
  };
  const reference = (named) => {
    if (named?.kind === 'pending') target(named.target);
    if (named?.kind === 'fieldAbsent') reference(named.recordBirth);
  };
  const recipe = (scope, item) => {
    if (item.kind === 'fields') {
      for (const each of item.targets) {
        if (Object.hasOwn(each, 'defaultValue')) each.defaultValue = valueOf(each.target, each.defaultValue);
        target(each.target);
      }
    }
    if (item.kind === 'createdRecord') target(item.record);
    if (item.kind === 'restore') {
      for (const op of item.operations) {
        if (op.kind === 'field') {
          op.before = valueOf(op.target, op.before);
          if (op.record?.f) op.record.f = registers(op.target, op.record.f);
        }
        if (op.kind === 'createRecord' && op.values.f) op.values.f = valuesOf(op.record, op.values.f);
        target(op.kind === 'field' ? op.target : op.record);
        reference(op.reference);
      }
    }
    if (item.kind === 'command') {
      const cmd = { name: item.command, args: { input: item.input } };
      references.remapCommand(scope, cmd, map);
      item.input = cmd.args.input;
      item.evidence.ownedFields.forEach(target);
      item.evidence.unchangedCreatedRecords.forEach(target);
      item.evidence.unchangedCreatedScopes = item.evidence.unchangedCreatedScopes.map((each) => map.scope(each));
    }
  };
  for (const act of replica.journal) {
    for (const source of act.sourceEntries) {
      for (const item of source.recipes) recipe(source.originScope, item);
      source.originScope = map.scope(source.originScope);
      for (const preimage of source.preimages) {
        preimage.value = valueOf(preimage.target, preimage.value);
        if (preimage.record?.f) preimage.record.f = registers(preimage.target, preimage.record.f);
        target(preimage.target);
      }
      for (const item of source.written ?? []) {
        item.value = valueOf(item.target, item.value);
        target(item.target);
      }
      for (const attempt of source.attempts) {
        for (const effect of attempt.acceptedEffects ?? []) {
          for (const row of effect.rows) references.remapRecord(effect.scope, row, map);
          effect.scope = map.scope(effect.scope);
        }
      }
    }
  }
  for (const request of replica.inverses) {
    for (const slot of request.slots) {
      recipe(slot.originScope, slot.recipe);
      slot.originScope = map.scope(slot.originScope);
    }
  }
  for (const cancellation of replica.cancellations) {
    for (const source of cancellation.sourceEntries) source.originScope = map.scope(source.originScope);
    for (const unit of cancellation.units) {
      if (unit.kind === 'field') {
        unit.redoValue = valueOf(unit.target, unit.redoValue);
        if (unit.restoredValue !== undefined) unit.restoredValue = valueOf(unit.target, unit.restoredValue);
      } else if (unit.redoValues.f) unit.redoValues.f = valuesOf(unit.record, unit.redoValues.f);
      target(unit.kind === 'field' ? unit.target : unit.record);
      reference(unit.restored);
    }
  }
}
