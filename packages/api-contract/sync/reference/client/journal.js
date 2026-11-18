// K-3 the journal of reversible acts (§7.3 Undo of an act): each act's source entries with their recipes,
// first local preimages and the receipts or refusals their ACK transactions record, beside the inverse requests
// and cancellation receipts that read them; their retention, epochs, lifecycle and settlement. The journal is
// the replica's local user data: values and ids never leave it but in a restore's own arguments.

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
// answer's epoch, before its entry can settle or be collected. One attempt an epoch: a replay's replaces it.
export function retainOutcome(replica, localId, { epoch, n, outcome, acceptedEffects }) {
  const found = sourceOf(replica, localId);
  if (!found) return;
  const { source } = found;
  source.attempts = source.attempts.filter((attempt) => attempt.epoch !== epoch);
  source.attempts.push({ epoch, n, outcome, ...(acceptedEffects ? { acceptedEffects: structuredClone(acceptedEffects) } : {}) });
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
// included; an act left with none goes.
export function discardJournal(replica, registry, product) {
  for (const act of replica.journal) act.sourceEntries = act.sourceEntries.filter((source) => registry.productOfRef(source.originScope) !== product);
  replica.journal = replica.journal.filter((act) => act.sourceEntries.length > 0);
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

// An inverse request's slot settles with its outcomes, or every operation skipped by `code`.
export function settleSlot(replica, slot, outcomes, code) {
  const count = slot.recipe.kind === 'restore' ? slot.recipe.operations.length : 1;
  slot.outcomes = outcomes ?? Array.from({ length: count }, (_, index) => ({ index, s: 'skipped', code }));
  slot.state = 'settled';
}

// A request settles once every slot has: changed is whether any slot's accepted effects changed a row.
export function settleRequest(replica, request) {
  if (request.state === 'settled' || request.slots.some((slot) => slot.state !== 'settled')) return;
  const outcomes = request.slots.flatMap((slot) => slot.outcomes);
  request.state = 'settled';
  request.result = { kind: 'settled', requestId: request.requestId, inverseActId: request.inverseActId,
    changed: request.slots.some((slot) => slot.changed === true),
    appliedCount: outcomes.filter(({ s }) => s === 'applied').length,
    skippedCount: outcomes.filter(({ s }) => s === 'skipped').length };
  collectJournal(replica);
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

// §7.7 write map and E-8: a journal's scoped references follow the same logical map as the queue.
export function remapJournal(registry, replica, map) {
  const { references } = registry;
  const target = (holder) => {
    references.remapRecord(holder.scope, holder, map);
    holder.scope = map.scope(holder.scope);
  };
  for (const act of replica.journal) {
    for (const source of act.sourceEntries) {
      source.originScope = map.scope(source.originScope);
      for (const recipe of source.recipes) {
        if (recipe.kind === 'fields') recipe.targets.forEach((item) => target(item.target));
        if (recipe.kind === 'createdRecord') target(recipe.record);
        if (recipe.kind === 'command') {
          const cmd = { name: recipe.command, args: { input: recipe.input } };
          references.remapCommand(source.originScope, cmd, map);
          recipe.input = cmd.args.input;
          recipe.evidence.ownedFields.forEach(target);
          recipe.evidence.unchangedCreatedRecords.forEach(target);
          recipe.evidence.unchangedCreatedScopes = recipe.evidence.unchangedCreatedScopes.map((scope) => map.scope(scope));
        }
      }
      source.preimages.forEach((preimage) => target(preimage.target));
      for (const attempt of source.attempts) {
        for (const effect of attempt.acceptedEffects ?? []) {
          for (const row of effect.rows) references.remapRecord(effect.scope, row, map);
          effect.scope = map.scope(effect.scope);
        }
      }
    }
  }
}
