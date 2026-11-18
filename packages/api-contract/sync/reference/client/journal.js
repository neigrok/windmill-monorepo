// K-3 the journal of reversible acts (§7.3 Undo of an act). An act opted into Undo keeps, in its replica,
// each source entry's recipes and first local preimages, taken before any segment changed a projection, and
// each accepted receipt or refusal its ACK transaction records before the entry can settle. The journal is
// the replica's local user data: values and ids never leave it but in a restore's own arguments.

import { recipeFault, valueIn } from '../core/restore.js';
import { recordKey } from '../core/rows.js';
import { CommitError } from './commit.js';
import { drawn } from './views.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The one capture command of a scope's kind (§2.4). None or several is a programming error, never a choice
// by name.
export function captureCommandOf(registry, scope) {
  const kind = registry.scopeKindOf(scope);
  const found = [...registry.commands.values()].filter((command) => command.engine === 'capture' && command.scope === kind);
  if (found.length !== 1) throw new CommitError(`${kind} has no single capture command`);
  return found[0].name;
}

// The local id's ordinal: its position in its act's commit order.
export function ordinalOf(localId) {
  return Number(localId.slice(localId.lastIndexOf('/') + 1));
}

// ActRequest.undo, checked against its scopes, with each segment's first local preimages read from the act's
// initial snapshot (§7.1 Ordered local acts). A slot unset there takes the recipe's explicit default; with
// none, the act fails before anything changes. Answers the plan by segment index, or null.
export function planUndo(replica, registry, request) {
  const { undo } = request;
  if (undo === undefined || undo === null) return null;
  if (!isObject(undo) || Object.keys(undo).sort().join() !== 'segments,version' || undo.version !== 1 || !Array.isArray(undo.segments))
    throw new CommitError('an act undo is {version: 1, segments}');
  const plan = new Map();
  for (const segment of undo.segments) {
    if (!isObject(segment) || Object.keys(segment).sort().join() !== 'index,recipes' || !Number.isSafeInteger(segment.index)
      || segment.index < 0 || segment.index >= request.scopes.length || plan.has(segment.index)
      || !Array.isArray(segment.recipes) || segment.recipes.length === 0) throw new CommitError('an undo segment names one act segment and its recipes');
    const scope = request.scopes[segment.index];
    const view = drawn(replica, registry, scope);
    const preimages = [];
    for (const recipe of segment.recipes) {
      const fault = recipeFault(registry, scope, recipe);
      if (fault) throw new CommitError(`an undo recipe is malformed: ${fault}`);
      if (recipe.kind === 'createdRecord' && view.has(recordKey(recipe.record.t, recipe.record.id))) throw new CommitError('a created record exists before its act');
      if (recipe.kind !== 'fields') continue;
      for (const { target, defaultValue } of recipe.targets) {
        const value = valueIn(view.get(recordKey(target.t, target.id)), target.slot);
        if (value === undefined && defaultValue === undefined) throw new CommitError('an unset undo target needs its default');
        preimages.push({ target: structuredClone(target), value: structuredClone(value ?? defaultValue) });
      }
    }
    plan.set(segment.index, { scope, recipes: structuredClone(segment.recipes), preimages });
  }
  return plan;
}

// An opted segment's gesture runs its own scopedEffects command, or else the capture command, which joins it
// only when the segment writes a delta.
export function optedGesture(registry, scope, opts) {
  if (opts.cmd === undefined) return { ...opts, capture: captureCommandOf(registry, scope) };
  if (!registry.command(opts.cmd.name)?.scopedEffects) throw new CommitError('an opted command returns scoped effects');
  return opts;
}

// The act's journal record, from the segments that left an entry: one source entry each, in commit order.
export function recordAct(replica, actId, plan, receipts) {
  if (plan === null) return;
  const sourceEntries = [];
  for (const [index, { scope, recipes, preimages }] of [...plan].sort(([a], [b]) => a - b)) {
    const { localIds } = receipts[index];
    if (localIds.length === 0) continue;
    if (localIds.length > 1) throw new CommitError('an opted segment commits one intent');
    sourceEntries.push({ localId: localIds[0], originScope: scope, recipes, preimages, attempts: [] });
  }
  if (sourceEntries.length) replica.journal.push({ version: 1, actId, retained: true, sourceEntries });
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
