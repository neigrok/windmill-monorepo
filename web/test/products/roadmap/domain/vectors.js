// @ts-check
// Roadmap's shared vectors on the web: the pure reads over normalized records, and the actions (`*-actions.json`)
// through the kit's ProductCorpus over the roadmap registry.

import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { translateUndo } from '../../../../src/platform/domain-kit/translation.js';
import { Registry } from '../../../../../packages/api-contract/sync/reference/core/registry.js';
import { CreateRoadmap, CreateSubtree, DeleteRoadmap, Roadmap, SetVisibility, WriteRoadmap, redoCreateSubtree } from '../../../../src/products/roadmap/domain/roadmaps.js';
import { RoadmapProduct } from '../../../../../packages/api-contract/sync/reference/roadmap/product.js';
import { jcs } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { Harness } from '../../../platform/domain-kit/harness.js';
import { RoadmapRules } from '../../../../src/products/roadmap/domain/ruleBook.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { ChangePrerequisites, ChangeStep, CreateStep, DeleteStep, ImportSteps, MoveStep } from '../../../../src/products/roadmap/domain/steps.js';
import { ChangeKind, CreateKind, DeleteKind, MoveKind, RecolourKind } from '../../../../src/products/roadmap/domain/kinds.js';
import { ClearPointer, Complete, Reset, SetPointer } from '../../../../src/products/roadmap/domain/progress.js';
import { AddStepLink, AddSubtask, ChangeStepLink, ChangeSubtask, DeleteStepLink, DeleteSubtask, MoveStepLink, MoveSubtask, SaveStepNote, StepNote, StepNoteValue } from '../../../../src/products/roadmap/domain/workspace.js';
import { ClearLanding, cannotLand, landingOf } from '../../../../src/products/roadmap/domain/landing.js';
import { RoadmapRefusals, RoadmapScopes, refusalForm } from '../../../../src/products/roadmap/domain/roadmapRules.js';
import { Contract, savedForm } from '../../../platform/domain-kit/vectors.js';
import { RoadmapTree } from '../../../../src/products/roadmap/domain/records.js';
import { FollowGraph } from '../../../../src/products/roadmap/domain/graph.js';
import { RoadmapAccount } from '../../../../src/products/roadmap/domain/account.js';
import { BoardRead, LegendRead, selectNodes, landingFacts } from '../../../../src/products/roadmap/domain/reads.js';
import { diagnose, pointerDiagnostics } from '../../../../src/products/roadmap/domain/diagnostics.js';

/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */

export const roadmapRegistry = new Registry(Contract.json('sync/roadmap.registry.json'));
export const roadmapBook = new RoadmapRules(roadmapRegistry).book;
const corpus = new ProductCorpus(roadmapBook, RoadmapRules.spec);

/** @param {any} input */
function actOf(input) {
  const { action, input: given } = input;
  switch (action) {
    case 'CreateRoadmap': return new CreateRoadmap(given.title, given.steps);
    case 'DeleteRoadmap': return new DeleteRoadmap(given.tree);
    case 'SetVisibility': return new SetVisibility(given.tree, given.visibility);
    case 'CreateSubtree': return new CreateSubtree(given.tree, given.step);
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
    case 'Complete': return Complete(given.tree, given.step, { outOfOrder: given.outOfOrder ?? false, opensStanding: given.opensStanding ?? false });
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

// A step's note saved from the draft its editor opens over the scene's overlay.
/** @param {Vector} vector */
function noteSave(vector) {
  const { tree, step, text } = vector.input.input;
  const scope = RoadmapScopes.overlay(tree);
  /** @type {any} */
  let decided = null;
  const form = /** @type {any} */ (corpus.save((draft) => {
    const save = SaveStepNote(draft);
    return { scope: save.scope, refusals: save.refusals, load: (read) => save.load(read), decide: (loaded) => (decided = save.decide(loaded)) };
  }, vector, new StepNoteValue(new Id(step, StepNote)), (note) => new StepNoteValue(note.id, text), savedForm, refusalForm, scope));
  const recipes = form.decision.write ? translateUndo(decided.plan, scope) : null;
  return recipes === null ? form : { decision: { write: { ...form.decision.write, undo: recipes } } };
}

/** @param {Vector} vector */
function readResult(vector) {
  const input = vector.input;
  if (input.read === 'cannotLand') return { result: cannotLand(input.input.notices, roadmapRegistry) };
  if (input.read !== 'landing') throw new Error(`no roadmap read ${input.read}`);
  return corpus.read(vector, RoadmapScopes.tree(input.input.tree), (read) => {
    const landing = landingOf(input.input.tree, read);
    return { follows: landing.follows, cameBack: landing.cameBack, note: landing.note.json };
  });
}

/**
 * @param {Vector} vector
 * @returns {Json}
 */
export function runAction(vector) {
  const input = vector.input;
  if (input.read !== undefined) return /** @type {Json} */ (/** @type {unknown} */ (readResult(vector)));
  if (input.action === 'SaveStepNote') return noteSave(vector);
  const act = /** @type {import('../../../../src/platform/domain-kit/acts.js').ActAction<any, any, any>} */ (actOf(input));
  /** @type {any} */
  let decided = null;
  const form = /** @type {any} */ (corpus.act({ refusals: act.refusals, load: (read) => act.load(read), decide: (loaded, ids) => (decided = act.decide(loaded, ids)) },
    vector, (result) => /** @type {Json} */ (result), refusalForm));
  if (!form.decision.write) return form;
  // K-3: each segment's Undo recipes as the engine journals them (translateUndo), where the segment opts in.
  form.decision.write.segments = form.decision.write.segments.map((/** @type {any} */ segment, /** @type {number} */ index) => {
    const recipes = translateUndo(decided.plan.segments[index].plan, segment.scope);
    return recipes === null ? segment : { ...segment, undo: recipes };
  });
  return form;
}

// K-3 scenes (`undo.json`): acts and a note's draft saves on the kit's harness over the reference server with roadmap's
// binding, then their Undo and Redo. A step names a role's result by `$role` or `$role.path`, also inside a scope; what a scene reads back
// names each id by the first role that holds it, and any other minted id `<new>`.
/** @param {Vector} vector */
export async function runScene(vector) {
  const a = await Harness.open({ registry: roadmapRegistry, product: new RoadmapProduct(), scope: RoadmapScopes.account });
  /** @type {Record<string, Harness>} */
  const phones = { a };
  /** @type {Record<string, { input: any, result: any, actId: string | null, requestId: string | null }>} */
  const roles = {};
  /** @param {string} path */
  const lookup = (path) => {
    const [role = '', ...keys] = path.split('.');
    return keys.reduce((found, key) => found?.[key], roles[role]?.result);
  };
  /** @param {any} value @returns {any} */
  const bind = (value) => {
    if (Array.isArray(value)) return value.map(bind);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)]));
    if (typeof value !== 'string' || !value.includes('$')) return value;
    const whole = /^\$([\w.]+)$/.exec(value);
    if (whole) return lookup(whole[1] ?? '');
    return value.replace(/\$([\w.]+)/g, (_, path) => String(lookup(path)));
  };
  /** @param {any} value @returns {any} */
  const named = (value) => {
    /** @type {Map<string, string>} */
    const known = new Map();
    /** @param {any} found @param {string} path */
    const walk = (found, path) => {
      if (typeof found === 'string') { if (!known.has(found)) known.set(found, path); }
      else if (found !== null && typeof found === 'object') for (const [key, item] of Object.entries(found)) walk(item, `${path}.${key}`);
    };
    for (const [role, { result }] of Object.entries(roles)) walk(result, `$${role}`);
    /** @param {any} item @returns {any} */
    const rename = (item) => {
      if (typeof item === 'string') return known.get(item) ?? (/^(t_[0-9a-f]{16}|[0-9a-z]{16})$/.test(item) ? '<new>' : item);
      if (Array.isArray(item)) return item.map(rename);
      if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, rename(inner)]));
      return item;
    };
    return rename(value);
  };
  /** @param {any} result */
  const inverse = (result) => {
    const { requestId, inverseActId, ...form } = result;
    return form;
  };
  const observeAll = () => {
    for (const phone of Object.values(phones)) {
      for (const record of phone.runner.read(RoadmapScopes.account, (read) => read.views.visible('drawn', Roadmap.type))) {
        a.observe(RoadmapScopes.tree(String(record.id)));
        a.observe(RoadmapScopes.overlay(String(record.id)));
      }
    }
  };
  /** @type {any[]} */
  const outcomes = [];
  try {
    for (const step of vector.input.steps) {
      if (step.device) {
        phones[step.device] = await a.device();
        continue;
      }
      const phone = /** @type {Harness} */ (phones[step.on ?? 'a']);
      if (step.run) {
        const input = bind(step.input);
        const outcome = await phone.runner.runAct(/** @type {any} */ (actOf({ action: step.run, input })));
        if (step.as) {
          roles[step.as] = { input, result: outcome.kind === 'refused' ? null : outcome.result,
            actId: outcome.kind === 'committed' ? outcome.receipt.gestureId : null, requestId: null };
        }
        outcomes.push(outcome.kind === 'refused' ? { refused: refusalForm(outcome.refusal) } : outcome.kind);
      } else if (step.save) {
        const { tree, step: owner, text } = bind(step.input);
        const scope = RoadmapScopes.overlay(tree);
        const id = new Id(owner, StepNote);
        const draft = phone.runner.openOrNew(StepNote, id, new StepNoteValue(id), scope).edit((note) => new StepNoteValue(note.id, text));
        const { result } = await phone.runner.save(draft, RoadmapRefusals, scope);
        if (step.as) roles[step.as] = { input: { tree, step: owner, text }, result: null, actId: result.kind === 'saved' ? result.receipt?.gestureId ?? null : null, requestId: null };
        outcomes.push(result.kind);
      } else if (step.sync) {
        observeAll();
        await a.sync();
      } else if (step.advance) {
        await a.advance(step.advance);
      } else if (step.undo || step.redo) {
        const role = roles[step.undo ?? step.redo];
        if (role === undefined) throw new Error(`no scene role ${step.undo ?? step.redo}`);
        const fresh = step.redo && step.subtree ? String(phone.runner.mint(Roadmap).record) : null;
        const slots = fresh === null ? undefined : redoCreateSubtree({ ...role.input, ...role.result }, fresh);
        if (fresh !== null) for (const scope of [RoadmapScopes.tree(fresh), RoadmapScopes.overlay(fresh)]) a.observe(scope);
        const result = step.undo ? await phone.runner.undo(String(role.actId)) : await phone.runner.redo(String(role.requestId), slots);
        if (result.kind !== 'unavailable') role.requestId = result.requestId;
        outcomes.push(inverse(result));
      } else if (step.read) {
        outcomes.push(inverse(phone.runner.inverseResult(String(roles[step.read]?.requestId))));
      } else if (step.cancelHeld) {
        outcomes.push({ cancelHeld: await phone.runner.cancelHeld(String(roles[step.cancelHeld]?.actId)) });
      } else if (step.inspect) {
        const { scope, t, fields } = step.inspect;
        const rows = phone.runner.read(bind(scope), (read) => read.views.visible('drawn', t)).map((record) => Object.fromEntries(fields.map((/** @type {string} */ name) =>
          [name, name === 'id' ? record.id : record.f?.[name]?.[0] ?? record.x?.[name] ?? null])));
        outcomes.push({ [t]: named(rows).sort((/** @type {any} */ x, /** @type {any} */ y) => (jcs(x) < jcs(y) ? -1 : jcs(x) > jcs(y) ? 1 : 0)) });
      } else {
        throw new Error(`no scene step ${Object.keys(step).join()}`);
      }
    }
    return { outcomes };
  } finally {
    a.close();
  }
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
