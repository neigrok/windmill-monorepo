// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { EntityType, Fields, Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Plan, Prediction } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Check, Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation, precondition } from '../../../platform/domain-kit/values.js';
import { Catalogue, Exercise } from './catalogue.js';
import { GymRefusals, ProposalRules, RoutineRules } from './gymRules.js';
import { Routine, RoutineEntry, SetTarget } from './routines.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Instant} Instant */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */
/** @typedef {import('./gymRules.js').ChangeRules} ChangeRules */

export class EntryTargets {
  /** @param {readonly SetTarget[] | null} sets @param {number | null} restSeconds */
  constructor(sets = null, restSeconds = null) {
    this.sets = sets === null ? null : Object.freeze([...sets]);
    this.restSeconds = restSeconds;
    Object.freeze(this);
  }

  /** @param {RoutineEntry} entry */
  static fromEntry(entry) { return new EntryTargets(entry.sets, entry.restSeconds); }

  /** @param {Fields} fields */
  static decode(fields) { return new EntryTargets(fields.optionalList('sets', SetTarget.decode), fields.optionalInt('restSeconds')); }

  /** @returns {Record<string, Json>} */
  get json() {
    return { ...(this.sets === null ? {} : { sets: this.sets.map((set) => set.json) }),
      ...(this.restSeconds === null ? {} : { restSeconds: this.restSeconds }) };
  }

}

export class RoutineChange {
  /** @param {string} kind @param {Id<ExerciseValue>} exerciseId @param {EntryTargets | null} before @param {EntryTargets | null} after */
  constructor(kind, exerciseId, before = null, after = null) {
    this.kind = kind;
    this.exerciseId = exerciseId;
    this.before = before;
    this.after = after;
    Object.freeze(this);
  }

  /** @param {Fields} fields */
  static decode(fields) {
    return new RoutineChange(fields.string('kind'), fields.ref('exerciseId', Exercise),
      fields.optionalValue('before', EntryTargets.decode), fields.optionalValue('after', EntryTargets.decode));
  }

  /** @returns {Record<string, Json>} */
  get json() {
    return { kind: this.kind, exerciseId: this.exerciseId.json,
      ...(this.before === null ? {} : { before: this.before.json }), ...(this.after === null ? {} : { after: this.after.json }) };
  }

  // Each proposed entry against the first unmatched base entry of its movement, in the proposed order, then every base entry
  // left unmatched as a removal.
  /** @param {readonly RoutineEntry[]} base @param {readonly RoutineEntry[]} proposed */
  static between(base, proposed) {
    const matched = new Set();
    const changes = proposed.map((entry) => {
      const index = base.findIndex((before, at) => !matched.has(at) && before.exerciseId.equals(entry.exerciseId));
      const next = EntryTargets.fromEntry(entry);
      if (index === -1) return new RoutineChange('added', entry.exerciseId, null, next);
      matched.add(index);
      const before = base[index];
      precondition(before !== undefined, 'a matched base entry is present');
      const previous = EntryTargets.fromEntry(before);
      return new RoutineChange(sameJson(previous.json, next.json) ? 'kept' : 'retargeted', entry.exerciseId, previous, next);
    });
    for (const [index, entry] of base.entries()) {
      if (!matched.has(index)) changes.push(new RoutineChange('removed', entry.exerciseId, EntryTargets.fromEntry(entry)));
    }
    return Object.freeze(changes);
  }

  /** @param {readonly RoutineChange[]} changes */
  static document(changes) {
    return Object.freeze(changes.filter((change) => change.kind !== 'removed')
      .map((change) => new RoutineEntry(change.exerciseId, change.after?.sets ?? null, change.after?.restSeconds ?? null)));
  }

  // A line sets new targets when it adds its movement or retargets its sets; a rest-only retarget or a kept line keeps what it held.
  get setsNewTargets() {
    if (this.kind === 'added') return true;
    return this.kind === 'retargeted' && !sameJson(this.before?.json.sets ?? null, this.after?.json.sets ?? null);
  }

  // The editor's load floor on every line that sets new targets, in change order then set order; a movement the catalogue
  // lacks has no floor here.
  /** @param {readonly RoutineChange[]} changes @param {Catalogue} catalogue @param {Path} path */
  static floored(changes, catalogue, path) {
    changes.forEach((change, index) => {
      const movement = catalogue.find(change.exerciseId);
      if (change.setsNewTargets && movement !== null) SetTarget.floored(change.after?.sets ?? [], movement, path.plus(index).plus('after').plus('sets'));
    });
  }

  // R118's count: every line that is not kept, and one more when the kept movements left the base's order.
  /** @param {readonly RoutineEntry[]} base @param {readonly RoutineChange[]} changes */
  static count(base, changes) {
    const unmatched = base.map((entry, index) => ({ entry, index }));
    let greatest = -1;
    let reordered = false;
    for (const change of changes) {
      if (change.kind !== 'kept' && change.kind !== 'retargeted') continue;
      const at = unmatched.findIndex(({ entry }) => entry.exerciseId.equals(change.exerciseId));
      if (at === -1) continue;
      const [matched] = unmatched.splice(at, 1);
      precondition(matched !== undefined, 'a matched base entry is present');
      if (matched.index < greatest) reordered = true;
      greatest = Math.max(greatest, matched.index);
    }
    return changes.filter((change) => change.kind !== 'kept').length + (reordered ? 1 : 0);
  }
}

// A proposal's change lines checked by its type's rules: their count, each line's kind, movement and sides, then removals last.
/** @param {ChangeRules} rules @param {readonly RoutineChange[]} changes @param {Path} path */
export function validatedChanges(rules, changes, path) {
  /** @param {import('./gymRules.js').TargetSpecs} specs @param {EntryTargets} value @param {Path} at */
  const targets = (specs, value, at) => new EntryTargets(specs.sets.applyOptional(value.sets === null ? null : [...value.sets], at.plus('sets'),
    (/** @type {SetTarget} */ target, /** @type {Path} */ place) => {
      if (target.reps === 0) throw new Violation(rules.zeroTarget, place.plus('reps'), { kind: 'custom', custom: 'zeroTarget' });
      const reps = specs.reps.applyOptional(target.reps, place.plus('reps'));
      const weightKg = specs.weight.applyOptional(target.weightKg, place.plus('weightKg'));
      if (weightKg === 0 && target.weightKg !== 0) throw new Violation(rules.zeroTarget, place.plus('weightKg'), { kind: 'custom', custom: 'zeroTarget' });
      return new SetTarget(reps, weightKg);
    }), specs.rest.applyOptional(value.restSeconds, at.plus('restSeconds')));
  const checked = rules.changes.apply([...changes], path, (change, at) => {
    const kind = rules.kind.apply(change.kind, at.plus('kind'));
    rules.exercise.apply(typeof change.exerciseId.record === 'string' ? change.exerciseId.record : '', at.plus('exerciseId'));
    if ((kind === 'added') !== (change.before === null) || (kind === 'removed') !== (change.after === null)) {
      throw new Violation(rules.changes.path, at, { kind: 'custom', custom: 'side' });
    }
    return new RoutineChange(kind, change.exerciseId, change.before === null ? null : targets(rules.before, change.before, at.plus('before')),
      change.after === null ? null : targets(rules.after, change.after, at.plus('after')));
  });
  const removed = checked.findIndex((change) => change.kind === 'removed');
  if (removed >= 0 && checked.slice(removed).some((change) => change.kind !== 'removed')) {
    throw new Violation(rules.changes.path, path, { kind: 'custom', custom: 'removalsLast' });
  }
  return checked;
}

export class ProposalValue {
  /**
   * @param {{ id: Id<ProposalValue>, routineId: Id<RoutineValue>, intent: string, proposedName: string,
   *   summary: string, changes: readonly RoutineChange[], door?: string, connection?: string, agent?: string,
   *   state?: string, supersededBy?: Id<ProposalValue> | null, settledAt?: Instant | null,
   *   baseRevision?: number | null, baseName?: string | null, changeCount?: number | null, threadId?: string | null }} input
   */
  constructor({ id, routineId, intent, proposedName, summary, changes, door = 'ask', connection = '', agent = '',
    state = 'pending', supersededBy = null, settledAt = null, baseRevision = null, baseName = null, changeCount = null, threadId = null }) {
    this.id = id;
    this.routineId = routineId;
    this.intent = intent;
    this.proposedName = proposedName;
    this.summary = summary;
    this.changes = Object.freeze([...changes]);
    this.door = door;
    this.connection = connection;
    this.agent = agent;
    this.state = state;
    this.supersededBy = supersededBy;
    this.settledAt = settledAt;
    this.baseRevision = baseRevision;
    this.baseName = baseName;
    this.changeCount = changeCount;
    this.threadId = threadId;
    Object.freeze(this);
  }

  fields() {
    return { routineId: this.routineId.json, intent: this.intent, proposedName: this.proposedName, summary: this.summary,
      changes: this.changes.map((change) => change.json), door: this.door, connection: this.connection, agent: this.agent };
  }

  get document() { return RoutineChange.document(this.changes); }

  /** @returns {Record<string, Json>} */
  get provenance() {
    return Object.freeze(this.door === 'ask' ? { door: 'ask', threadId: this.threadId }
      : { door: this.door, connection: this.connection, agent: this.agent });
  }

  /** @param {RoutineValue} base */
  countChanges(base) {
    if (this.changeCount !== null) return this.changeCount;
    return RoutineChange.count(base.entries, this.changes) + (base.name === this.proposedName ? 0 : 1);
  }
}

/** @type {EntityType<ProposalValue>} */
export const Proposal = new EntityType({
  type: 'proposal', scope: 'self/gym',
  decode: (fields) => new ProposalValue({ id: new Id(fields.id, Proposal), routineId: fields.ref('routineId', Routine),
    intent: fields.string('intent'), proposedName: fields.string('proposedName', ''), summary: fields.string('summary', ''),
    changes: fields.list('changes', RoutineChange.decode), door: fields.string('door', 'ask'), connection: fields.string('connection', ''),
    agent: fields.string('agent', ''), state: fields.string('state', 'pending'), supersededBy: fields.optionalRef('supersededBy', Proposal),
    settledAt: fields.optionalInstant('settledAt'), baseRevision: fields.optionalInt('baseRevision'), baseName: fields.optionalString('baseName'),
    changeCount: fields.optionalInt('changeCount'), threadId: fields.optionalString('threadId') }),
  checks: [
    new Check('intent', (value) => new ProposalValue({ ...value, intent: ProposalRules.intent.apply(value.intent, new Path('intent')) })),
    new Check('proposedName', (value) => new ProposalValue({ ...value, proposedName: ProposalRules.name.apply(value.proposedName, new Path('proposedName')) })),
    new Check('summary', (value) => new ProposalValue({ ...value, summary: ProposalRules.change.summary.apply(value.summary, new Path('summary')) })),
    new Check('changes', (value) => new ProposalValue({ ...value, changes: validatedChanges(ProposalRules.change, value.changes, new Path('changes')) })),
    new Check('door', (value) => new ProposalValue({ ...value, door: ProposalRules.change.door.apply(value.door, new Path('door')) })),
    new Check('connection', (value) => new ProposalValue({ ...value, connection: ProposalRules.change.connection.apply(value.connection, new Path('connection')) })),
    new Check('agent', (value) => new ProposalValue({ ...value, agent: ProposalRules.change.agent.apply(value.agent, new Path('agent')) })),
  ],
});

/** @param {Json} value @returns {Json} */
function frozenJson(value) {
  if (Array.isArray(value)) return /** @type {Json[]} */ (Object.freeze(value.map(frozenJson)));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenJson(item)])));
  }
  return value;
}

export class RoutineCreationValue {
  /** @param {Id<RoutineCreationValue>} id @param {Json | null} snapshot */
  constructor(id, snapshot = null) {
    this.id = id;
    this.snapshot = frozenJson(snapshot);
    Object.freeze(this);
  }
}

/** @type {EntityType<RoutineCreationValue>} */
export const RoutineCreation = new EntityType({ type: 'routineCreation', scope: 'self/gym',
  decode: (fields) => new RoutineCreationValue(new Id(fields.id, RoutineCreation), fields.json('snapshot') ?? null) });

/** @param {readonly RoutineEntry[]} base @param {readonly RoutineEntry[]} proposed */
export function changesBetween(base, proposed) {
  return RoutineChange.between(base, proposed.map((entry) => entry.validated(new Path('entries'))));
}

/**
 * @param {{ id: Id<ProposalValue>, routineId: Id<RoutineValue>, name: string,
 *   entries: readonly RoutineEntry[], summary: string, removing?: boolean }} input
 */
export function ProposeRoutine({ id, routineId, name, entries, summary, removing = false }) {
  const requested = Object.freeze([...entries]);
  return Object.freeze({
    scope: Proposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) {
      const routines = read.repository(Routine);
      return { routine: routines.find(routineId, 'stored'), routineVisible: routines.find(routineId, 'drawn') !== null,
        catalogue: new Catalogue(read, 'stored'), moment: read.moment };
    },
    /** @param {{ routine: RoutineValue | null, routineVisible: boolean, catalogue: Catalogue, moment: Moment }} loaded */
    decide(loaded) {
      const base = loaded.routine;
      if (base === null || !loaded.routineVisible) return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-record', routineId.ref, null, 'predicted')));
      const proposed = removing ? [] : RoutineRules.entries.apply([...requested], new Path('entries'));
      const proposedName = removing ? '' : RoutineRules.name.apply(name, new Path('name'));
      if (proposed.some((entry) => loaded.catalogue.find(entry.exerciseId) === null)) {
        return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-exercise', id.ref, null, 'predicted')));
      }
      const changes = RoutineChange.between(base.entries, proposed);
      RoutineChange.floored(changes, loaded.catalogue, new Path('changes'));
      if (!removing && base.name === proposedName && sameJson(base.entries.map((entry) => entry.json), proposed.map((entry) => entry.json))) {
        return Decision.unchanged(id);
      }
      const proposal = new ProposalValue({ id, routineId: base.id, intent: removing ? 'remove' : 'revise', proposedName, summary, changes });
      const plan = new Plan();
      plan.create(new Valid(proposal, loaded.moment));
      plan.guardRead(base.id, ['entries', 'name']);
      return Decision.write(plan, id);
    },
  });
}

// A proposal with its routine three ways: as this device stores it, whether it is in sight, and as the log last confirmed it.
export class ProposalState {
  /**
   * @param {{ proposal: ProposalValue | null, routine: RoutineValue | null, moment: Moment,
   *   routineVisible?: boolean, confirmedRoutine?: RoutineValue | null }} parts
   */
  constructor({ proposal, routine, moment, routineVisible = true, confirmedRoutine = null }) {
    this.proposal = proposal;
    this.routine = routine;
    this.routineVisible = routineVisible;
    this.confirmedRoutine = confirmedRoutine;
    this.moment = moment;
    Object.freeze(this);
  }

  /** @param {Reader} read @param {Id<ProposalValue>} id */
  static of(read, id) {
    const proposal = read.repository(Proposal).find(id, 'stored');
    const routines = read.repository(Routine);
    const confirmed = proposal === null ? null : read.confirmed(Routine, proposal.routineId);
    return new ProposalState({ proposal, moment: read.moment,
      routine: proposal === null ? null : routines.find(proposal.routineId, 'stored'),
      routineVisible: proposal !== null && routines.find(proposal.routineId, 'drawn') !== null,
      confirmedRoutine: confirmed === null ? null : Routine.decode(Fields.record(confirmed)) });
  }

  // What the log would answer the decision, said before it is sent; applying also needs the routine as the proposal found it, in sight.
  /** @param {Id<ProposalValue>} id @param {boolean} applying */
  refusal(id, applying) {
    const proposal = this.proposal;
    if (proposal === null) return GymRefusals.ofRefused(new Refused('unknown-record', id.ref, null, 'predicted'));
    if (proposal.state === 'superseded') {
      if (proposal.supersededBy !== null) return this.superseded(id, 'replaced');
      const revision = this.routine?.revision ?? null;
      if (revision === null || proposal.baseRevision === null) return null;
      return this.superseded(id, revision === proposal.baseRevision ? 'superseded' : 'routine-changed');
    }
    if (proposal.state === 'pending') {
      if (!applying) return null;
      if (this.routineMoved(proposal)) return this.superseded(id, 'routine-changed');
      if (this.routine === null || !this.routineVisible) return GymRefusals.ofRefused(new Refused('unknown-record', proposal.routineId.ref, null, 'predicted'));
      return null;
    }
    if (proposal.state === (applying ? 'applied' : 'dismissed')) return null;
    return GymRefusals.ofRefused(new Refused('proposal-settled', id.ref, { state: proposal.state }, 'predicted'));
  }

  // Out of date, a proposal can no longer be applied: replaced, set aside by the log, or its routine moved while it waited.
  get outOfDate() {
    const proposal = this.proposal;
    if (proposal === null) return false;
    if (proposal.state === 'superseded' || proposal.supersededBy !== null) return true;
    return proposal.state === 'pending' && this.refusal(proposal.id, true) !== null;
  }

  // The log counted a new revision, or this device holds a name or movements the log will count before it reads the decision.
  /** @param {ProposalValue} proposal */
  routineMoved(proposal) {
    const revision = this.routine?.revision ?? null;
    if (revision !== null && proposal.baseRevision !== null && revision !== proposal.baseRevision) return true;
    if (this.routine === null || this.confirmedRoutine === null) return false;
    return this.routine.name !== this.confirmedRoutine.name
      || !sameJson(this.routine.entries.map((entry) => entry.json), this.confirmedRoutine.entries.map((entry) => entry.json));
  }

  /** @param {Id<ProposalValue>} id @param {string} reason */
  superseded(id, reason) { return GymRefusals.ofRefused(new Refused('proposal-superseded', id.ref, { reason }, 'predicted')); }
}

/** @typedef {{ state: ProposalState, catalogue: Catalogue }} ProposalApplication */

/** @param {Id<ProposalValue>} id */
export function ApplyProposal(id) {
  return Object.freeze({
    scope: Proposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read @returns {ProposalApplication} */
    load(read) { return { state: ProposalState.of(read, id), catalogue: new Catalogue(read, 'stored') }; },
    /** @param {ProposalApplication} loaded */
    decide({ state, catalogue }) {
      const refused = state.refusal(id, true);
      if (refused !== null) return Decision.refuse(refused);
      const proposal = state.proposal;
      precondition(proposal !== null, 'an applicable proposal exists');
      if (proposal.state === 'applied') return Decision.unchanged(null);
      const command = { name: 'gym.applyProposal', args: { proposalId: id.json }, specs: [] };
      if (proposal.state === 'superseded') return Decision.write(Plan.running(command), null);
      RoutineChange.floored(proposal.changes, catalogue, new Path('changes'));
      const change = proposal.intent === 'remove' ? Prediction.remove(proposal.routineId)
        : Prediction.update(proposal.routineId, { name: proposal.proposedName, entries: proposal.document.map((entry) => entry.json) });
      const settled = Prediction.update(id, { state: 'applied', settledAt: state.moment.now.ms });
      return Decision.write(Plan.running(command, [settled, change]), null);
    },
  });
}

/** @param {Id<ProposalValue>} id */
export function DismissProposal(id) {
  return Object.freeze({
    scope: Proposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return ProposalState.of(read, id); },
    /** @param {ProposalState} loaded */
    decide(loaded) {
      const refused = loaded.refusal(id, false);
      if (refused !== null) return Decision.refuse(refused);
      const proposal = loaded.proposal;
      precondition(proposal !== null, 'a dismissible proposal exists');
      if (proposal.state === 'dismissed') return Decision.unchanged(null);
      const command = { name: 'gym.dismissProposal', args: { proposalId: id.json }, specs: [] };
      if (proposal.state === 'superseded') return Decision.write(Plan.running(command), null);
      const settled = Prediction.update(id, { state: 'dismissed', settledAt: loaded.moment.now.ms });
      return Decision.write(Plan.running(command, [settled]), null);
    },
  });
}

export const REMOVAL_RECEIPTS = 'rack:removalReceipts';

/** @param {Reader} read */
export function removalReceipts(read) {
  if (read.isAnonymous) return [];
  const commands = read.commands();
  const rows = Fields.object(read.device(REMOVAL_RECEIPTS) ?? {}).values;
  return Object.freeze(Object.entries(rows).map(([id, raw]) => {
    const row = Fields.object(raw, 'proposal', 'receipt');
    const status = row.string('status');
    if (status !== 'pending' && status !== 'applied' && status !== 'refused') throw row.failure('status', 'unknown outcome');
    const pending = commands.some(({ command }) => command.name === 'gym.applyProposal' && command.args.proposalId === id);
    const outcome = status === 'applied' && pending ? 'pending' : status;
    const snapshot = Fields.object(row.present('snapshot'), 'proposal', 'receipt.snapshot').values;
    const proposal = Proposal.decode(Fields.values('proposal', id, { ...snapshot, ...(outcome === 'applied' ? { state: 'applied' } : {}) }));
    return Object.freeze({ proposal, outcome, code: row.optionalString('code'), detail: row.json('detail') ?? null });
  }).sort((a, b) => Id.compare(a.proposal.id, b.proposal.id)));
}

/** @param {Id<ProposalValue>} id */
export function ApplyProposalKeepingReceipt(id) {
  const action = ApplyProposal(id);
  precondition(typeof id.record === 'string', 'a proposal id is a string');
  const key = id.record;
  return Object.freeze({
    scope: Proposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return { application: action.load(read), rows: Fields.object(read.device(REMOVAL_RECEIPTS) ?? {}).values }; },
    /** @param {{ application: ProposalApplication, rows: Record<string, Json> }} loaded */
    decide(loaded) {
      const receipt = loaded.rows[key];
      if (receipt !== undefined && Fields.object(receipt).string('status') !== 'refused') return Decision.unchanged(null);
      const decided = action.decide(loaded.application);
      const proposal = loaded.application.state.proposal;
      if (decided.kind !== 'write' || proposal === null || proposal.intent !== 'remove') return decided;
      const snapshot = { ...proposal.fields(), state: proposal.state, supersededBy: proposal.supersededBy?.json ?? null,
        settledAt: proposal.settledAt?.ms ?? null, baseRevision: proposal.baseRevision, baseName: proposal.baseName,
        changeCount: proposal.changeCount, threadId: proposal.threadId };
      decided.plan.device(REMOVAL_RECEIPTS, { ...loaded.rows, [key]: { snapshot, status: 'pending' } });
      return decided;
    },
  });
}

/** @param {Id<ProposalValue>} id @param {'pending' | 'applied' | 'refused' | null} expectedOutcome */
export function AcknowledgeRoutineRemoval(id, expectedOutcome = null) {
  return Object.freeze({
    scope: Proposal.scope,
    refusals: GymRefusals,
    /** @param {Reader} read */
    load(read) { return { rows: Fields.object(read.device(REMOVAL_RECEIPTS) ?? {}).values, receipts: removalReceipts(read) }; },
    /** @param {{ rows: Record<string, Json>, receipts: ReturnType<typeof removalReceipts> }} loaded */
    decide(loaded) {
      if (!loaded.receipts.some((receipt) => receipt.proposal.id.equals(id) && receipt.outcome !== 'pending'
        && (expectedOutcome === null || receipt.outcome === expectedOutcome))) return Decision.unchanged(null);
      const remaining = Object.fromEntries(Object.entries(loaded.rows).filter(([key]) => key !== id.record));
      const plan = new Plan();
      plan.device(REMOVAL_RECEIPTS, Object.keys(remaining).length ? remaining : null);
      return Decision.write(plan, null);
    },
  });
}
