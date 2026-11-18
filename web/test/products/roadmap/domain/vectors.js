// @ts-check
// Roadmap's shared vectors on the web: the pure reads over normalized records, and the actions
// (`*-actions.json`) over the kit: an act's load over each scope's records, its decision, and each segment's
// gesture by the roadmap registry.

import { ActIDSource, ActReader } from '../../../../src/platform/domain-kit/acts.js';
import { IDSource, decision } from '../../../../src/platform/domain-kit/actions.js';
import { Draft } from '../../../../src/platform/domain-kit/drafts.js';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Reader, Views } from '../../../../src/platform/domain-kit/reading.js';
import { translate } from '../../../../src/platform/domain-kit/translation.js';
import { Fault, Violation } from '../../../../src/platform/domain-kit/values.js';
import { recordKey } from '../../../../../packages/api-contract/sync/reference/core/rows.js';
import { Registry } from '../../../../../packages/api-contract/sync/reference/core/registry.js';
import { CreateRoadmap, DeleteRoadmap, WriteRoadmap } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { ChangePrerequisites, ChangeStep, CreateStep, DeleteStep, ImportSteps, MoveStep } from '../../../../src/products/roadmap/domain/steps.js';
import { ChangeKind, CreateKind, DeleteKind, MoveKind, RecolourKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { ClearPointer, Complete, Reset, SetPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { AddStepLink, AddSubtask, ChangeStepLink, ChangeSubtask, DeleteStepLink, DeleteSubtask, MoveStepLink, MoveSubtask, SaveStepNote, StepNote, StepNoteValue } from '../../../../src/products/roadmap/domain/workspace.js';
import { ClearLanding, cannotLand, landingOf } from '../../../../src/products/roadmap/domain/landing.js';
import { RoadmapScopes, refusalForm } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { Contract, momentOf, savedForm, viewRecords } from '../../../platform/domain-kit/vectors.js';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead, LegendRead, selectNodes, landingFacts } from '../../../../src/products/roadmap/domain/reads.js';
import { diagnose, pointerDiagnostics } from '../../../../src/products/roadmap/domain/diagnostics.js';

/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */

export const roadmapRegistry = new Registry(Contract.json('sync/roadmap.registry.json'));

// What one scope of a scene hands a reader: its records, the device rows, and nothing pending.
/** @param {any} input @param {string} scope */
function viewsOf(input, scope) {
  const records = input.scopes?.[scope] ?? { drawn: [] };
  /** @param {any[]} rows */
  const keyed = (rows) => new Map(viewRecords(rows).map((record) => [recordKey(record.t, record.id), record]));
  const stored = records.stored ?? records.drawn;
  return { drawn: keyed(records.drawn), stored: keyed(stored), confirmed: keyed(stored), devices: input.device ?? {}, firstPullComplete: true, now: input.now };
}

/** @param {any} input */
function mintsFrom(input) {
  const left = [...(input.ids ?? [])];
  return (/** @type {string} */ type) => {
    const id = left.shift();
    if (id === undefined) throw new Fault(`the vector lists no id left to mint a ${type}`);
    return id;
  };
}

/** @param {any} input */
function actOf(input) {
  const { action, input: given } = input;
  switch (action) {
    case 'CreateRoadmap': return new CreateRoadmap(given.title, given.steps);
    case 'DeleteRoadmap': return new DeleteRoadmap(given.tree);
    case 'WriteRoadmap': return new WriteRoadmap(given.tree, Object.fromEntries(['title', 'guide'].filter((name) => name in given).map((name) => [name, given[name]])));
    case 'CreateStep': return new CreateStep(given.tree, given.step, given.prerequisites);
    case 'ChangeStep': return new ChangeStep(given.tree, given.step, given.changes);
    case 'MoveStep': return new MoveStep(given.tree, given.step, given.below, given.siblings);
    case 'DeleteStep': return new DeleteStep(given.tree, given.step);
    case 'ChangePrerequisites': return new ChangePrerequisites(given.tree, given.step, { add: given.add, remove: given.remove });
    case 'ImportSteps': return new ImportSteps(given.tree, given.imported, given.under ?? null);
    case 'CreateKind': return new CreateKind(given.tree, given.kind);
    case 'ChangeKind': return new ChangeKind(given.tree, given.kind, given.changes);
    case 'RecolourKind': return new RecolourKind(given.tree, given.kind, given.hue);
    case 'MoveKind': return new MoveKind(given.tree, given.kind, given.below);
    case 'DeleteKind': return new DeleteKind(given.tree, given.kind);
    case 'Complete': return Complete(given.tree, given.step, given.outOfOrder ?? false);
    case 'Reset': return Reset(given.tree, given.step);
    case 'SetPointer': return SetPointer(given.tree, given.step, given.opens);
    case 'ClearPointer': return ClearPointer(given.tree, given.step);
    case 'AddSubtask': return AddSubtask(given.tree, given.step, given.label);
    case 'ChangeSubtask': return ChangeSubtask(given.tree, given.subtask, given.changes);
    case 'MoveSubtask': return MoveSubtask(given.tree, given.subtask, given.below);
    case 'DeleteSubtask': return DeleteSubtask(given.tree, given.subtask);
    case 'AddStepLink': return AddStepLink(given.tree, given.step, given.link);
    case 'ChangeStepLink': return ChangeStepLink(given.tree, given.link, given.changes);
    case 'MoveStepLink': return MoveStepLink(given.tree, given.link, given.below);
    case 'DeleteStepLink': return DeleteStepLink(given.tree, given.link);
    case 'ClearLanding': return new ClearLanding(given.tree, given.told);
    default: throw new Error(`no roadmap action ${action}`);
  }
}

// An act's decision over the scene: load through an act reader, decide once, each segment translated in its scope.
/** @param {any} input */
function actDecision(input) {
  const mint = mintsFrom(input);
  /** @type {import('../../../../src/platform/domain-kit/acts.js').ActContext} */
  const context = {
    now: input.now,
    finishLoad() {},
    inScope: (scope, body) => body(viewsOf(input, scope)),
    mintID: (type) => mint(type),
    opaqueID: () => { throw new Fault('a roadmap act mints no opaque id'); },
  };
  const act = actOf(input);
  const reader = new ActReader(context, roadmapRegistry, momentOf(input));
  const loaded = act.load(reader);
  reader.end();
  /** @type {any} */
  let decided;
  try {
    decided = act.decide(/** @type {any} */ (loaded), new ActIDSource(context));
  } catch (error) {
    if (!(error instanceof Violation)) throw error;
    return { decision: { refuse: refusalForm(act.refusals.ofViolation(error)) } };
  }
  if (decided.kind === 'refuse') return { decision: { refuse: refusalForm(decided.refusal) } };
  if (decided.kind === 'unchanged') return { decision: { unchanged: { result: decided.result } } };
  const segments = decided.plan.segments.map((/** @type {any} */ segment) => ({ scope: segment.scope, gesture: translate(segment.plan, segment.scope, roadmapRegistry) }));
  return { decision: { write: { segments, result: decided.result } } };
}

// A step's note saved from the draft its editor opens over the scene's overlay.
/** @param {any} input */
function noteSave(input) {
  const { tree, step, text } = input.input;
  const scope = RoadmapScopes.overlay(tree);
  const read = new Reader(new Views(roadmapRegistry, { ...viewsOf(input, scope), mintId: mintsFrom(input) }), scope, momentOf(input));
  const id = new Id(step, StepNote);
  const held = read.repository(StepNote).find(id, 'drawn');
  const draft = (held === null ? Draft.new(new StepNoteValue(id), null, scope) : Draft.opening(held, scope)).edit((note) => new StepNoteValue(note.id, text));
  const save = SaveStepNote(draft);
  const decided = decision(save, save.load(read), new IDSource(read.views));
  if (decided.kind === 'refuse') return { decision: { refuse: refusalForm(decided.refusal) } };
  if (decided.kind === 'unchanged') return { decision: { unchanged: { result: savedForm(decided.result) } } };
  return { decision: { write: { segments: [{ scope, gesture: translate(decided.plan, scope, roadmapRegistry) }], result: savedForm(decided.result) } } };
}

/** @param {any} input */
function readResult(input) {
  if (input.read === 'cannotLand') return { result: cannotLand(input.input.notices, roadmapRegistry) };
  if (input.read !== 'landing') throw new Error(`no roadmap read ${input.read}`);
  const scope = RoadmapScopes.tree(input.input.tree);
  const read = new Reader(new Views(roadmapRegistry, viewsOf(input, scope)), scope, momentOf(input));
  const landing = landingOf(input.input.tree, read);
  return { result: { follows: landing.follows, cameBack: landing.cameBack, note: landing.note.json } };
}

/**
 * @param {Vector} vector
 * @returns {Json}
 */
export function runAction(vector) {
  const input = vector.input;
  if (input.read !== undefined) return /** @type {Json} */ (/** @type {unknown} */ (readResult(input)));
  if (input.action === 'SaveStepNote') return /** @type {Json} */ (/** @type {unknown} */ (noteSave(input)));
  return /** @type {Json} */ (/** @type {unknown} */ (actDecision(input)));
}

/** @param {any} input */
export function runRead(input) {
  if (input.operation === 'account' || input.operation === 'guides' || input.operation === 'pointers' || input.operation === 'progress') {
    const account = new RoadmapAccount(input.trees.map((/** @type {any} */ tree) => new RoadmapTree(tree)));
    if (input.operation === 'account') return account.result();
    if (input.operation === 'progress') return account.progress(input.tree);
    return input.operation === 'guides' ? account.guides(input.tree) : pointerDiagnostics(account, input.tree);
  }
  const tree = new RoadmapTree(input.tree);
  if (input.operation === 'legend') return new LegendRead(tree).result();
  if (input.operation === 'search') return selectNodes(tree, input.query);
  const graph = new FollowGraph(tree);
  if (input.operation === 'graph') return graph.result(input.subjects);
  if (input.operation === 'board') return new BoardRead(graph, input.query).result();
  if (input.operation === 'diagnostics') return diagnose(graph);
  if (input.operation === 'landing') return landingFacts(graph, input.own);
  throw new Error(`Unclaimed roadmap read operation: ${input.operation}`);
}
