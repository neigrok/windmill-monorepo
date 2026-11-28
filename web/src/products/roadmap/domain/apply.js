// @ts-check
// Roadmap Coach §7: a proposal the person decides on the review. Apply writes its changes as the person's own act, whole
// or not at all: the device's row naming the proposal, the base and the changes checked again over the copy as it is now,
// and the folded result written one write a register, with the room's recolours first, under one gesture and one Undo
// across the roadmap's structure and the person's marks. The row is written in the act's own transaction, so a row found
// `applying` names an act that landed, and settling it makes the record `applied`, a write of its own after the act: an
// Undo in the act's hold cancels every entry of the act, and the record's state is none of them. Reject marks the record
// rejected. An Undo of an applied proposal is the kit's, and `ProposalUndone` marks the record once it took something back.

import { ActDecision, ActPlan, ScopedPlan } from '../../../platform/domain-kit/acts.js';
import { Id, compareText } from '../../../platform/domain-kit/entities.js';
import { Plan, UndoRecipe } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { utf8 } from '../../../platform/sync/core/encoding.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ProposalFold, baseMoved } from './abilities/proposals.js';
import { StandingRoadmaps, readReached } from './abilities/standing.js';
import { CoachProposal, pendingProposal } from './conversation.js';
import { KindRestore, RoadmapKind, RoadmapKindValue, recolouring } from './kinds.js';
import { StepMark, StepMarkValue } from './progress.js';
import { HeldRecord, Restore, RoadmapRefusals, RoadmapScopes, gone, restoring, writeIn } from './roadmapRules.js';
import { RoadmapLink, RoadmapLinkValue, RoadmapStep, RoadmapStepValue, importChunks, linkedNames, readNote } from './steps.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/acts.js').ActReader} ActReader */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('./conversation.js').CoachProposalValue} CoachProposalValue */
/** @typedef {import('./conversation.js').ProposalState} ProposalState */
/** @typedef {import('./abilities/standing.js').Standing} Standing */
/** @typedef {import('./records.js').LandingNote} LandingNote */
/** @typedef {'undone' | 'skipped' | 'unavailable'} UndoOutcome */
/** @typedef {{ kind: string, changed?: boolean, localChanged?: boolean, appliedCount?: number, skippedCount?: number, reason?: string }} UndoResult an Undo's result, its ids aside */

// §7 The device's own row naming a proposal it is applying, `applying:<proposal>`. Its `stamp` is null: the row is written
// in its act's own transaction, so its being there says the act landed.
export const ApplyingRow = Object.freeze({
  prefix: 'applying:',
  /** @param {Id<CoachProposalValue>} proposal */
  key: (proposal) => `applying:${proposal.record}`,
  value: Object.freeze({ stamp: null }),
});

// What a decision on a proposal reads of it: the record as the device draws it, whether the device holds the row of its
// Apply, the roadmap's pending proposal, and the moment.
/** @param {Reader} account @param {Id<CoachProposalValue>} id */
function readProposal(account, id) {
  const proposal = account.repository(CoachProposal).find(id, 'drawn');
  return {
    proposal,
    applying: account.device(ApplyingRow.key(id)) !== null,
    pending: proposal?.treeId == null ? null : pendingProposal(account, proposal.treeId),
    moment: account.moment,
  };
}

/** @typedef {ReturnType<typeof readProposal>} ProposalRead */

// A proposal's record taking a terminal state, its one field, answering that state.
/** @param {CoachProposalValue} proposal @param {ProposalState} state @param {Moment} moment */
function marked(proposal, state, moment) {
  const plan = new Plan();
  plan.update(new Valid(proposal.with({ state }), moment, ['state']), { fields: ['state'] });
  return writeIn(RoadmapScopes.account, plan, state);
}

// §7 Only a pending proposal moves. A proposal the device does not draw, or that names no roadmap, is gone; one whose Apply
// has written its row is applied, and one that is not pending answers the state it stands in, nothing written; and a
// pending one that is not its roadmap's pending one, where two devices each minted one before they synced, is replaced,
// which the decision writes. Answers that decision, or null for a proposal the person's decision moves.
/** @param {ProposalRead} found @param {Id<CoachProposalValue>} id */
function unmoved({ proposal, applying, pending, moment }, id) {
  if (proposal === null || proposal.treeId === null) return gone(CoachProposal.type, id.record);
  if (applying) return ActDecision.unchanged(/** @type {ProposalState} */ ('applied'));
  if (proposal.state !== 'pending') return ActDecision.unchanged(proposal.state);
  if (pending === null || !pending.id.equals(proposal.id)) return marked(proposal, 'replaced', moment);
  return null;
}

// One record's write in a chunk of the act's structure: its count and its canonical bytes, as the import measures its
// units, and how it writes itself into the chunk's plan with its Undo.
class RecordUnit {
  /** @param {Json} measured @param {(plan: Plan) => void} writeTo */
  constructor(measured, writeTo) {
    this.count = 1;
    this.bytes = utf8(jcs(measured)).length;
    this.writeTo = writeTo;
    Object.freeze(this);
  }
}

// §7 step 3: the act a fold's reduction writes, segment by segment, in order: the room's recolours of the kinds the
// copy holds, one command each; the structure, kinds and steps and then links, cut into chunks as an import's; the steps
// it removes, held as every step's delete is; the person's marks in their overlay; and the device's rows, the one naming
// the proposal and the landing note of its new steps and links (Roadmap on the sync engine §6).
class AppliedAct {
  /**
   * @param {Id<CoachProposalValue>} proposal
   * @param {string} treeId
   * @param {ProposalFold} fold
   * @param {LandingNote} note
   * @param {Moment} moment
   */
  constructor(proposal, treeId, fold, note, moment) {
    this.proposal = proposal;
    this.treeId = treeId;
    this.fold = fold;
    this.note = note;
    this.moment = moment;
    this.reduced = fold.reduced;
    this.steps = new Map((fold.input.nodes ?? []).map((node) => [node.id, node]));
    this.kinds = new Map((fold.input.kinds ?? []).map((kind) => [kind.id, kind]));
    Object.freeze(this);
  }

  get plan() {
    const { recolours, kinds, nodes, links, marks } = this.reduced;
    const tree = RoadmapScopes.tree(this.treeId);
    const commands = recolours.map(({ kind, hue, wearers }, index) => {
      const plan = recolouring(this.treeId, this.kindOf(kind), hue, wearers.map((id) => new Id(id, RoadmapStep)), { restored: true, checked: false });
      if (index === 0) plan.undoCheckedBy(this.legendRestore);
      return new ScopedPlan(tree, plan);
    });
    const units = [...kinds.map((write) => this.kindUnit(write)), ...nodes.filter((write) => write.created || !write.removed).map((write) => this.stepUnit(write)),
      ...links.map((write) => this.linkUnit(write))];
    const structure = importChunks(units).filter((chunk) => chunk.length).map((chunk) => {
      const plan = new Plan();
      for (const unit of chunk) unit.writeTo(plan);
      return new ScopedPlan(tree, plan);
    });
    const removed = nodes.filter((write) => write.removed);
    const deaths = removed.length ? [new ScopedPlan(tree, this.removing(removed))] : [];
    const overlay = marks.length ? [new ScopedPlan(RoadmapScopes.overlay(this.treeId), this.marking(marks))] : [];
    return new ActPlan([...commands, ...structure, ...deaths, ...overlay, new ScopedPlan(RoadmapScopes.account, this.rows(nodes, links))]);
  }

  // The one check the act's Undo asks, the legend as the whole Undo leaves it: each kind the act recolours back on the hue
  // the copy holds, each kind it makes taken away, and no kind outside the act wearing a hue given back. A kind of the
  // act's own that wears such a hue now, recoloured or made by it, stands in no Undo's way.
  get legendRestore() {
    const recoloured = [...new Set(this.reduced.recolours.map(({ kind }) => kind))];
    return new KindRestore(this.treeId, recoloured.map((kind) => ({ kind, hue: this.kindOf(kind).hue })),
      this.reduced.kinds.filter((write) => write.created).map((write) => write.id));
  }

  // A kind and a step as the copy holds them.
  /** @param {string} id */
  kindOf(id) {
    const held = /** @type {import('./records.js').KindInput} */ (this.kinds.get(id));
    return new RoadmapKindValue(new Id(id, RoadmapKind), { hue: held.hue, label: held.label ?? '', description: held.description ?? '', ord: held.ord ?? null });
  }

  /** @param {string} id */
  stepOf(id) {
    const held = /** @type {import('./records.js').StepInput} */ (this.steps.get(id));
    return new RoadmapStepValue(new Id(id, RoadmapStep), { label: held.label ?? '', icon: held.icon ?? '', color: held.color ?? 'terracotta', ord: held.ord ?? null,
      description: held.description ?? '', links: held.links ?? [], status: held.status ?? null, branch: held.branch ?? null });
  }

  // A record the copy holds, changed: revived with the fields it writes, as every change to a step or a kind carries its
  // life, and its Undo writing each back.
  /** @template {RoadmapKindValue | RoadmapStepValue} V @param {Plan} plan @param {V} value @param {Record<string, Json>} fields */
  changing(plan, value, fields) {
    const names = Object.keys(fields).sort(compareText);
    new HeldRecord(value, 'present').reviving(new Valid(/** @type {any} */ (value).with(fields), this.moment, names), names, plan);
  }

  /** @param {import('./abilities/proposals.js').RecordWrite} write */
  kindUnit({ id, created, fields }) {
    const kindId = new Id(id, RoadmapKind);
    return new RecordUnit({ t: RoadmapKind.type, id, f: fields }, (plan) => {
      if (!created) return this.changing(plan, this.kindOf(id), fields);
      plan.create(new Valid(new RoadmapKindValue(kindId, /** @type {any} */ (fields)), this.moment));
      plan.undoBy(UndoRecipe.createdRecord(Restore.tree, kindId));
    });
  }

  // A step the act makes, with the Undo that deletes it again, but one it makes and removes, which the Undo leaves removed.
  /** @param {import('./abilities/proposals.js').RecordWrite} write */
  stepUnit({ id, created, removed, fields }) {
    const stepId = new Id(id, RoadmapStep);
    return new RecordUnit({ t: RoadmapStep.type, id, f: fields }, (plan) => {
      if (!created) return this.changing(plan, this.stepOf(id), fields);
      plan.create(new Valid(new RoadmapStepValue(stepId, /** @type {any} */ (fields)), this.moment));
      if (!removed) plan.undoBy(UndoRecipe.createdRecord(Restore.tree, stepId));
    });
  }

  // A link made, made alive again or removed, each with the Undo the room's own link writes take.
  /** @param {import('./abilities/proposals.js').LinkWrite} write */
  linkUnit({ from, to, alive, created }) {
    const link = new RoadmapLinkValue(from, to);
    return new RecordUnit({ t: RoadmapLink.type, id: [from, to] }, (plan) => {
      if (alive) plan.create(new Valid(link, this.moment));
      else plan.remove(link.id);
      plan.undoBy(created ? UndoRecipe.createdRecord(Restore.tree, link.id) : restoring(Restore.tree, link.id, [], { life: true }));
    });
  }

  // The steps the act removes, held, as the room's delete of a step: each the copy holds brought back by its Undo, and one
  // the act itself made left removed.
  /** @param {import('./abilities/proposals.js').RecordWrite[]} removed */
  removing(removed) {
    const plan = new Plan();
    for (const { id, created } of removed) {
      const stepId = new Id(id, RoadmapStep);
      plan.remove(stepId);
      if (!created) plan.undoBy(restoring(Restore.tree, stepId, [], { life: true }));
    }
    return plan;
  }

  // The person's marks, each written back by its Undo, as Complete and Reset write theirs.
  /** @param {import('./abilities/proposals.js').MarkWrite[]} marks */
  marking(marks) {
    const plan = new Plan();
    for (const { node, mark } of marks) {
      const id = new Id(node, StepMark);
      plan.create(new Valid(new StepMarkValue(id, mark.status, mark.outOfOrder), this.moment), { fields: ['mark'] });
      plan.undoBy(restoring(Restore.overlay, id, ['mark']));
    }
    return plan;
  }

  // The device's rows: the one naming the proposal, and the landing note taking the act's new steps and links, each link
  // with the name of the step it comes from, as the room's creates note theirs.
  /** @param {import('./abilities/proposals.js').RecordWrite[]} nodes @param {import('./abilities/proposals.js').LinkWrite[]} links */
  rows(nodes, links) {
    const plan = new Plan();
    plan.device(ApplyingRow.key(this.proposal), ApplyingRow.value);
    const made = nodes.filter((write) => write.created && !write.removed).map((write) => write.id);
    const linked = links.filter((write) => write.alive).map(({ from, to }) => [from, to]);
    if (made.length || linked.length) {
      plan.device(RoadmapScopes.landing(this.treeId), this.note.adding({ nodes: made, edges: linked,
        names: linkedNames(this.fold.tree, linked.map(([from = '']) => from)) }).json);
    }
    return plan;
  }
}

// A state that passes by itself refuses an Apply and writes nothing, so it never makes a proposal stale: a roadmap the device
// has not finished bringing (`roadmap-unavailable`), and changes that pass a cap only by the steps under a delete the person
// can still undo, which free their slots when their hold ends (`roadmap-not-ready`).
/** @param {string} treeId @param {string} code */
function waiting(treeId, code) {
  return ActDecision.refuse(RoadmapRefusals.ofRefused(new Refused(code, { t: 'tree', id: treeId }, null, 'predicted')));
}

// §7 Apply, pressed by the person on the review: only a pending proposal moves; the roadmap must be the person's own, else
// it is gone, and held whole; a state that passes by itself refuses and writes nothing (`waiting`); a base that moved, or
// changes that no longer fold over the copy as it is now, mark the proposal `stale` and write nothing to the roadmap;
// otherwise the act. It answers the state the proposal stands in, `applied` for the act, whose receipt carries its Undo. It
// reads the proposal's roadmap and the roadmaps that roadmap's reading reaches, none else.
export class ApplyProposal {
  /** @param {Id<CoachProposalValue>} proposal */
  constructor(proposal) {
    this.proposal = proposal;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    const found = read.inScope(RoadmapScopes.account, (account) => readProposal(account, this.proposal));
    const treeId = found.proposal?.treeId ?? null;
    if (treeId === null) return { found, standing: null, note: null };
    return { found, standing: readReached(read, treeId), note: read.inScope(RoadmapScopes.tree(treeId), (tree) => readNote(treeId, tree)) };
  }

  /** @param {ReturnType<ApplyProposal['load']>} loaded */
  decide({ found, standing, note }) {
    const still = unmoved(found, this.proposal);
    if (still !== null) return still;
    const proposal = /** @type {CoachProposalValue} */ (found.proposal);
    const treeId = /** @type {string} */ (proposal.treeId);
    const copy = /** @type {Required<Standing>} */ (standing);
    const opened = StandingRoadmaps.of(copy).open(treeId, null);
    if (!('roadmap' in opened)) return 'refused' in opened && opened.refused.code === 'roadmap-unavailable' ? waiting(treeId, 'roadmap-unavailable') : gone('tree', treeId);
    if (baseMoved(copy, treeId, proposal.base)) return marked(proposal, 'stale', found.moment);
    const changes = /** @type {any[]} */ ([...proposal.changes]);
    const folded = ProposalFold.over(copy, treeId, changes);
    if (!('fold' in folded)) {
      const passesOnceHeld = 'refused' in folded && folded.refused.code === 'over-limit' && 'fold' in ProposalFold.over({ ...copy, held: [] }, treeId, changes);
      return passesOnceHeld ? waiting(treeId, 'roadmap-not-ready') : marked(proposal, 'stale', found.moment);
    }
    const act = new AppliedAct(this.proposal, treeId, folded.fold, /** @type {LandingNote} */ (note), found.moment);
    return ActDecision.write(act.plan, /** @type {ProposalState} */ ('applied'));
  }
}

// §7 A row found `applying`, after a crash or written by another tab, is settled by its act, which landed with it: its
// proposal becomes `applied`, which outranks a state another device wrote meanwhile, and the row goes, with every other
// row found. It answers the proposals whose rows it settled, in id order.
export class SettleApplying {
  constructor() {
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({
      rows: Object.keys(account.devices(ApplyingRow.prefix)).sort(compareText).map((key) => {
        const id = new Id(key.slice(ApplyingRow.prefix.length), CoachProposal);
        return { key, id, proposal: account.repository(CoachProposal).find(id, 'drawn') };
      }),
      moment: account.moment,
    }));
  }

  /** @param {ReturnType<SettleApplying['load']>} loaded */
  decide({ rows, moment }) {
    if (rows.length === 0) return ActDecision.unchanged(/** @type {string[]} */ ([]));
    const plan = new Plan();
    for (const { key, proposal } of rows) {
      if (proposal !== null && proposal.state !== 'applied') plan.update(new Valid(proposal.with({ state: 'applied' }), moment, ['state']), { fields: ['state'] });
      plan.device(key, null);
    }
    return writeIn(RoadmapScopes.account, plan, rows.map(({ id }) => String(id.record)));
  }
}

// §7 Reject, on the card or the review: a pending proposal becomes `rejected`, and nothing is written to the roadmap.
export class RejectProposal {
  /** @param {Id<CoachProposalValue>} proposal */
  constructor(proposal) {
    this.proposal = proposal;
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) { return read.inScope(RoadmapScopes.account, (account) => readProposal(account, this.proposal)); }

  /** @param {ProposalRead} found */
  decide(found) {
    return unmoved(found, this.proposal) ?? marked(/** @type {CoachProposalValue} */ (found.proposal), 'rejected', found.moment);
  }
}

// What an Undo came to as the device draws it: `undone` where it took something back, cancelled in its hold, drawn while
// it waits for the server or settled; `skipped` where it took nothing back; `unavailable` where there was none to ask.
/** @param {UndoResult} undo @returns {UndoOutcome} */
export function undoOutcome(undo) {
  if (undo.kind === 'unavailable') return 'unavailable';
  const took = undo.kind === 'cancelled' ? undo.changed : undo.kind === 'pending' ? undo.localChanged : (undo.appliedCount ?? 0) > 0;
  return took === true ? 'undone' : 'skipped';
}

// §7 step 5: an applied proposal undone. The kit's Undo of its act takes it back; this marks the record `undone` once that
// Undo took something back as the device draws it, so an undone proposal is not offered again, and a card never says
// Undone of changes that stand. It answers what the Undo came to, as `roadmap_proposal_undone` tells it.
export class ProposalUndone {
  /** @param {Id<CoachProposalValue>} proposal @param {UndoResult} undo */
  constructor(proposal, undo) {
    this.proposal = proposal;
    this.outcome = undoOutcome(undo);
    this.refusals = RoadmapRefusals;
    Object.freeze(this);
  }

  /** @param {ActReader} read */
  load(read) {
    return read.inScope(RoadmapScopes.account, (account) => ({ proposal: account.repository(CoachProposal).find(this.proposal, 'drawn'), moment: account.moment }));
  }

  /** @param {ReturnType<ProposalUndone['load']>} loaded */
  decide({ proposal, moment }) {
    if (proposal === null) return gone(CoachProposal.type, this.proposal.record);
    if (this.outcome !== 'undone' || proposal.state !== 'applied' || proposal.undone) return ActDecision.unchanged(this.outcome);
    const plan = new Plan();
    plan.update(new Valid(proposal.with({ undone: true }), moment, ['undone']), { fields: ['undone'] });
    return writeIn(RoadmapScopes.account, plan, this.outcome);
  }
}
