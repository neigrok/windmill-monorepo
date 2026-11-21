// @ts-check
// The kit corpus (§15.2): every file under packages/api-contract/domain-kit has a handler here, every
// handler a file, and every vector reproduces its `expect` byte for byte by JCS. Each vector that lists
// records runs again with them reversed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { Registry } from '../../../../packages/api-contract/sync/reference/core/registry.js';
import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ActDecision, ActPlan, ScopedPlan } from '../../../src/platform/domain-kit/acts.js';
import { BrowserSyncEngine } from '../../../src/platform/sync/engine.js';
import { environment } from '../sync/fakes.js';
import { Decision, IDSource, decision, refusalSubject } from '../../../src/platform/domain-kit/actions.js';
import { Draft, SaveDraft } from '../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Id } from '../../../src/platform/domain-kit/entities.js';
import { Plan, PlanError, Prediction, UndoRecipe, UndoTarget } from '../../../src/platform/domain-kit/plans.js';
import { ProbeProduct } from '../../../../packages/api-contract/sync/reference/probe/product.js';
import { Harness } from './harness.js';
import { Capacity, Reader } from '../../../src/platform/domain-kit/reading.js';
import { DomainNotice, Refused } from '../../../src/platform/domain-kit/refusals.js';
import { ActionRunner, EngineReplica } from '../../../src/platform/domain-kit/runner.js';
import { Move, Remove } from '../../../src/platform/domain-kit/standardActions.js';
import { Instant, LocalDay } from '../../../src/platform/domain-kit/time.js';
import { translate } from '../../../src/platform/domain-kit/translation.js';
import { Valid } from '../../../src/platform/domain-kit/validation.js';
import { CountSpec, Fault, NumberSpec, Path, TextSpec, Violation } from '../../../src/platform/domain-kit/values.js';
import { RuleBook } from '../../../src/platform/domain-kit/rules.js';
import { ProductCorpus } from './productCorpus.js';
import { PROBE_SCOPE, ProbeRefusals, probeCommand, probeEntity, probeValue, probeScope, refusalForm } from './probe.js';
import { Contract, ContractError, VectorReplica, applySpec, decisionForm, draftForm, listsRecords, momentOf, outcomeForm, placementOf,
  probeRegistry, savedForm, specOf, vectorViews, withRecordsReversed } from './vectors.js';

/** @typedef {import('../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./probe.js').ProbeRefusal} ProbeRefusal */

const DIRECTORY = 'domain-kit';
const nothing = () => /** @type {Json} */ (null);

test('number specs omit absent bounds', () => {
  assert.deepEqual(new NumberSpec('load', { quantum: 0.01 }).json, { path: 'load', kind: 'number', integer: false, quantum: 0.01 });
  assert.deepEqual(new NumberSpec('load', { min: 0 }).json, { path: 'load', kind: 'number', min: 0, integer: false });
  assert.deepEqual(new NumberSpec('load', { max: 0 }).json, { path: 'load', kind: 'number', max: 0, integer: false });
});

/** @param {any} json */
const recordID = (json) => (json === undefined || json === null ? null : json);

/** @param {any} input */
const pathOf = (input, /** @type {any} */ spec) => new Path(input.at ?? spec.path.split('.').at(-1));

/** @param {any} input */
function valueVector(input) {
  if ('isBlank' in input) return { isBlank: TextSpec.isBlank(input.isBlank) };
  const spec = specOf(input.spec);
  if ('measure' in input) return { measured: /** @type {TextSpec} */ (spec).measure(input.measure) };
  try {
    return { value: applySpec(spec, input.value, pathOf(input, input.spec), input.as === 'int') };
  } catch (error) {
    if (error instanceof Violation) return { violation: error.json };
    throw error;
  }
}

/** @param {any} input */
function countVector(input) {
  const spec = new CountSpec(input.spec.path, { min: input.spec.min, max: input.spec.max });
  const itemSpec = input.itemSpec ? specOf(input.itemSpec) : null;
  try {
    const items = input.items === null ? null : spec.apply(/** @type {Json[]} */ (input.items), pathOf(input, input.spec),
      (item, at) => (itemSpec ? applySpec(itemSpec, item, at) : item));
    return { items };
  } catch (error) {
    if (error instanceof Violation) return { violation: error.json };
    throw error;
  }
}

/** @param {any} input */
function dayVector(input) {
  const day = (/** @type {string} */ key) => {
    const parsed = LocalDay.parse(input[key]);
    if (!parsed) throw new ContractError(`${input[key]} is no day`);
    return parsed;
  };
  switch (input.op) {
    case 'fromInstant':
      return { day: LocalDay.from(new Instant(input.ms), input.offsetSeconds).text };
    case 'parse':
      return { day: day('text').text };
    case 'adding':
      return { day: day('day').adding(input.days).text };
    case 'daysUntil':
      return { days: day('day').daysUntil(day('other')) };
    case 'weekday':
      return { weekday: day('day').weekday };
    default:
      throw new ContractError(`unknown day operation ${input.op}`);
  }
}

// A plan as plan/translate.json describes it: the command with its predictions first, then each operation.
/**
 * @param {any} input
 * @param {import('../../../src/platform/domain-kit/time.js').Moment} at
 */
function build(input, at) {
  const predictions = (input.predict ?? []).map((/** @type {any} */ prediction) => {
    const id = new Id(prediction.id, probeEntity(prediction.t));
    const scope = prediction.scope ?? null;
    if (prediction.op === 'create') return Prediction.create(id, prediction.f ?? {}, scope);
    if (prediction.op === 'write') return Prediction.write(id, prediction.f ?? {}, {}, scope);
    return Prediction.update(id, prediction.f ?? {}, scope);
  });
  const plan = input.cmd ? Plan.running(probeCommand(input.cmd.name, input.cmd.args ?? {}), predictions) : new Plan();
  for (const operation of input.plan) {
    if (operation.op === 'device') {
      plan.device(operation.key, operation.value ?? null);
      continue;
    }
    const type = probeEntity(operation.t);
    const id = new Id(operation.id, type);
    const valid = () => {
      const value = probeValue(type, operation.id, operation.f ?? {});
      return new Valid(value, at, operation.checked ?? operation.fields ?? Object.keys(value.fields()));
    };
    switch (operation.op) {
      case 'create':
        plan.create(valid(), operation.fields ? { fields: operation.fields } : {});
        break;
      case 'insert':
        if (!type.isOrdered) throw new PlanError(0, `an insert of ${type.type} is unexpressible`);
        plan.insert(valid(), recordID(operation.below));
        break;
      case 'update':
        plan.update(valid(), {
          ...(operation.fields ? { fields: operation.fields } : {}),
          ...(operation.base ? { from: probeValue(type, operation.id, operation.base) } : {}),
          guarded: operation.guarded ?? false,
        });
        break;
      case 'revive':
        plan.revive(valid(), { fields: operation.fields, ...(operation.base ? { from: probeValue(type, operation.id, operation.base) } : {}), guarded: operation.guarded ?? false });
        break;
      case 'remove':
        if (!type.isRemovable) throw new PlanError(0, `a remove of ${type.type} is unexpressible`);
        plan.remove(id);
        break;
      case 'move':
        if (!type.isOrdered) throw new PlanError(0, `a move of ${type.type} is unexpressible`);
        plan.move(id, recordID(operation.below) === null ? null : new Id(operation.below, type));
        break;
      case 'guardRead':
        plan.guardRead(id, operation.fields);
        break;
      default:
        throw new ContractError(`no plan operation ${operation.op}`);
    }
  }
  return plan;
}

/** @param {any} input */
function translateVector(input) {
  try {
    let registry = probeRegistry;
    if (input.tagField || input.linkFields) {
      const document = /** @type {any} */ (Contract.json('sync/probe.registry.json'));
      if (input.tagField) document.types.find((/** @type {any} */ type) => type.type === 'tag').fields.label = input.tagField;
      if (input.linkFields) document.types.find((/** @type {any} */ type) => type.type === 'link').fields = input.linkFields;
      registry = new Registry(document);
    }
    return { gesture: /** @type {Json} */ (/** @type {unknown} */ (translate(build(input, momentOf(input)), input.scope ?? PROBE_SCOPE, registry))) };
  } catch (error) {
    if (error instanceof Violation) return { violation: error.json };
    if (error instanceof PlanError) return { error: true };
    throw error;
  }
}

/** @param {any} input */
function answerOf(input) {
  if (input.receipt) {
    const { gestureId, localIds, retired, releaseAt } = input.receipt;
    return { receipt: { gestureId, localIds, retired, releaseAt: releaseAt ?? null } };
  }
  if (input.refused) return { refused: { code: input.refused.code, detail: input.refused.detail ?? null, notice: null } };
  return null;
}

/** @param {any} input */
async function pipelineVector(input) {
  const moment = momentOf(input);
  const replica = new VectorReplica({ drawn: input.drawn, stored: input.stored ?? input.drawn, spent: input.spent ?? [] }, moment.now.ms, answerOf(input));
  const runner = new ActionRunner(replica, probeRegistry, moment.zone);
  /** @type {import('../../../src/platform/domain-kit/actions.js').Decider<import('../../../src/platform/domain-kit/time.js').Moment, null, ProbeRefusal>} */
  const action = {
    scope: input.scope ?? PROBE_SCOPE,
    refusals: ProbeRefusals,
    load: (read) => read.moment,
    decide: (loaded) => Decision.write(build(input, loaded), null),
  };
  try {
    return { outcome: outcomeForm(await runner.run(action), nothing, refusalForm) };
  } catch (error) {
    if (error instanceof PlanError) return { error: true };
    throw error;
  }
}

/** @param {any} input */
async function actVector(input) {
  const env = environment();
  let draws = 0;
  const engine = await BrowserSyncEngine.open({ ...env.options, draw: (/** @type {number} */ bound) => Math.floor(draws++ / 16) % bound });
  try {
    const runner = new ActionRunner(new EngineReplica(engine), probeRegistry, momentOf(input).zone);
    if (input.mint) {
      const mint = input.mint;
      try {
        const result = await engine.commitAct((/** @type {import('../../../src/platform/domain-kit/acts.js').ActContext} */ context) => {
          if (mint.borrow) context.inScope(mint.scope, () => {});
          if (mint.caughtScope) { try { context.inScope(mint.caughtScope, () => {}); } catch { /* retained by the context */ } }
          const ids = Array.from({ length: mint.count }, () => context.mintID(mint.type, mint.scope));
          return { request: mint.new ? { scopes: [PROBE_SCOPE, mint.scope], hold: false } : null, value: ids };
        }, (/** @type {string[]} */ ids, /** @type {number} */ index) => ({ changes: index === 0
          ? [{ op: 'create', t: 'board', id: 'b_00000001' }]
          : [{ op: 'create', t: mint.type, id: ids[0], f: { label: 'New' } }] }));
        return { count: result.value.length, distinct: new Set(result.value).size === result.value.length, committed: result.outcome !== null };
      } catch (error) {
        if (error instanceof Error && 'kind' in error && error.kind === 'malformed') return { error: true };
        throw error;
      }
    }
    const result = await runner.runAct({ refusals: ProbeRefusals,
      load: (read) => read.moment,
      decide: (moment) => ActDecision.write(new ActPlan(input.segments.map((/** @type {any} */ item) => new ScopedPlan(item.scope, build(item, moment)))), null),
    });
    let outcome;
    if (result.kind === 'committed') {
      outcome = { kind: result.kind, scopes: result.receipt.segments.map((item) => item.scope), counts: result.receipt.segments.map((item) => item.localIds.length), held: result.receipt.releaseAt !== null };
      if (input.undo) await runner.cancelHeld(result.receipt.gestureId);
    } else outcome = result.kind === 'refused' ? { kind: result.kind, refusal: refusalForm(result.refusal) } : { kind: result.kind };
    const records = input.inspect.map((/** @type {any} */ item) => runner.read(item.scope, (read) => read.repository(probeEntity(item.t)).all('drawn')
      .map((record) => {
        const fields = record.fields();
        const raw = read.views.record('drawn', item.t, record.id.record);
        return { id: record.id.json, title: fields.title ?? null, ...(item.detail ? { fields, life: raw?.life?.[0] ?? null,
          bornSegment: result.kind === 'committed' ? result.receipt.segments.findIndex((segment) => segment.stamp === raw?.born) : -1 } : {}) };
      })));
    return { outcome, records };
  } finally { engine.close(); }
}

// K-3: Undo recipes in the vector language, each target or record named by type and id, in its own scope or
// its segment's.
/** @param {any} recipe */
function undoRecipeOf(recipe) {
  const idOf = (/** @type {any} */ item) => new Id(item.id, probeEntity(item.t));
  const targetOf = (/** @type {any} */ item) => new UndoTarget(idOf(item), item.slot, item.scope ?? null);
  if (recipe.kind === 'fields') return UndoRecipe.fields(recipe.restoreCommand, recipe.targets.map((/** @type {any} */ item) =>
    (Object.hasOwn(item, 'defaultValue') ? { target: targetOf(item), defaultValue: item.defaultValue } : targetOf(item))));
  if (recipe.kind === 'createdRecord') return UndoRecipe.createdRecord(recipe.restoreCommand, idOf(recipe));
  return UndoRecipe.command(recipe.command, recipe.input, { ownedFields: recipe.evidence.ownedFields.map(targetOf),
    unchangedCreatedRecords: recipe.evidence.unchangedCreatedRecords.map((/** @type {any} */ item) => ({ id: idOf(item), scope: item.scope ?? null })),
    unchangedCreatedScopes: recipe.evidence.unchangedCreatedScopes });
}

// An InverseResult without the ids the engine draws.
/** @param {import('../../../src/platform/domain-kit/runner.js').InverseResult} result */
function inverseForm(result) {
  const { requestId, inverseActId, ...rest } = /** @type {any} */ (result);
  return rest;
}

// run/undo.json: an act opted into Undo over the real engine and the reference server, then its Undo and Redo.
/** @param {any} input */
// run/undo.json and run/composed.json: an act, a composed act, a single action or a draft's save over the real local
// engine and the reference server, then Undo, Redo and held-cancel steps.
async function engineActVector(input) {
  const phone = await Harness.open({ registry: probeRegistry, product: new ProbeProduct(), scope: PROBE_SCOPE });
  try {
    for (const scope of input.observe ?? []) phone.observe(scope);
    const plans = (/** @type {any[]} */ segments) => segments.map((item) => {
      const plan = build(item, phone.runner.moment());
      if (item.undo?.length) plan.undoBy(...item.undo.map(undoRecipeOf));
      else if (item.undo) plan.evidenceForUndo();
      return new ScopedPlan(item.scope, plan);
    });
    for (const setup of input.before ?? []) {
      const done = await phone.runner.runAct({ refusals: ProbeRefusals, load: () => null, decide: () => ActDecision.write(new ActPlan(plans(setup)), null) });
      assert.equal(done.kind, 'committed');
      await phone.sync();
    }
    // A composed act's part: a plan as given, or `append`, which reads a record through the parts before it and
    // writes a field's value with a suffix, refusing when the record is gone.
    const partOf = (/** @type {any} */ item) => ({
      refusals: ProbeRefusals,
      load: (/** @type {import('../../../src/platform/domain-kit/acts.js').ActReader} */ read) => (item.append
        ? read.inScope(item.scope, (reader) => reader.repository(probeEntity(item.append.t)).find(new Id(item.append.id, probeEntity(item.append.t)), 'drawn'))
        : null),
      decide: (/** @type {any} */ found) => {
        if (item.unchanged) return ActDecision.unchanged(null);
        if (!item.append) return ActDecision.write(new ActPlan(plans([item])), null);
        const { t, id, field, suffix } = item.append;
        if (found === null) return ActDecision.refuse(ProbeRefusals.ofRefused(new Refused('unknown-record', new Id(id, probeEntity(t)).ref, null, 'predicted')));
        return ActDecision.write(new ActPlan(plans([{ ...item, plan: [{ op: 'update', t, id, f: { [field]: `${found.fields()[field]}${suffix}` }, fields: [field] }] }])), null);
      },
    });
    let actId = null;
    let outcome;
    try {
      if (input.parts) {
        const ran = await phone.runner.runComposed(input.parts.map(partOf));
        outcome = ran.kind === 'committed' ? { kind: ran.kind, counts: ran.receipt.segments.map((item) => item.localIds.length), held: ran.receipt.releaseAt !== null }
          : ran.kind === 'refused' ? { kind: ran.kind, part: ran.part, refusal: refusalForm(/** @type {any} */ (ran.refusal)) } : { kind: ran.kind };
        if (ran.kind === 'committed') actId = ran.receipt.gestureId;
      } else if (input.save) {
        const type = probeEntity(input.save.t);
        const opened = phone.runner.open(type, new Id(input.save.id, type), input.save.scope ?? probeScope(type));
        if (opened === null) throw new ContractError('a save opens a record the phone holds');
        const saved = await phone.runner.save(opened.edit(() => probeValue(type, input.save.id, input.save.current)), ProbeRefusals);
        outcome = { kind: saved.result.kind };
        if (saved.result.kind === 'saved' && saved.result.receipt !== null) actId = saved.result.receipt.gestureId;
      } else if (input.reversible !== undefined) {
        const segment = plans(input.segments)[0];
        if (segment === undefined) throw new ContractError('a single action names one segment');
        const ran = await phone.runner.run({ scope: segment.scope, refusals: ProbeRefusals, reversible: input.reversible,
          load: () => null, decide: () => Decision.write(segment.plan, null) });
        outcome = ran.kind === 'committed' ? { kind: ran.kind, count: ran.receipt.localIds.length } : { kind: ran.kind };
        if (ran.kind === 'committed') actId = ran.receipt.gestureId;
      } else {
        const ran = await phone.runner.runAct({ refusals: ProbeRefusals, load: () => null, decide: () => ActDecision.write(new ActPlan(plans(input.segments)), null) });
        outcome = ran.kind === 'committed' ? { kind: ran.kind, counts: ran.receipt.segments.map((item) => item.localIds.length), held: ran.receipt.releaseAt !== null } : { kind: ran.kind };
        if (ran.kind === 'committed') actId = ran.receipt.gestureId;
      }
    } catch (error) {
      if (error instanceof PlanError || error instanceof Fault) return { error: true };
      throw error;
    }
    const results = [];
    let requestId = null;
    for (const step of input.steps) {
      if (step === 'sync') await phone.sync();
      else if (step === 'cancel') results.push({ cancelled: await phone.runner.cancelHeld(/** @type {string} */ (actId)) });
      else if (step === 'read') results.push(inverseForm(phone.runner.inverseResult(/** @type {string} */ (requestId))));
      else {
        /** @type {import('../../../src/platform/domain-kit/runner.js').InverseResult} */
        const result = step === 'undo' ? await phone.runner.undo(/** @type {string} */ (actId)) : await phone.runner.redo(/** @type {string} */ (requestId));
        if (result.kind !== 'unavailable') requestId = result.requestId;
        results.push(inverseForm(result));
      }
    }
    const records = input.inspect.map((/** @type {any} */ item) => phone.runner.read(item.scope, (read) => read.repository(probeEntity(item.t)).all('drawn')
      .map((record) => ({ id: record.id.json, [item.field ?? 'title']: record.fields()[item.field ?? 'title'] ?? null }))));
    return { outcome, results, records };
  } finally { for (const each of phone.world.phones) each.engine.close(); }
}

/** @param {any} input */
function listVector(input) {
  const type = probeEntity(input.t);
  const views = vectorViews(input.records);
  const reader = new Reader(views, probeScope(type), momentOf(input));
  const repository = reader.repository(type);
  const ids = (/** @type {{ id: Id<any> }[]} */ entities) => entities.map((entity) => entity.id.json);
  if (input.view) return { ids: ids(repository.all(input.view)) };
  if (input.children) return { ids: ids(repository.children(new Id(input.children.of, type), input.children.via, input.children.view ?? 'drawn')) };
  if (input.remove) {
    if (!type.isRemovable) return { error: true };
    const remove = new Remove(new Id(input.remove.id, type), ProbeRefusals, probeScope(type));
    return { decision: decisionForm(remove.decide(remove.load(reader)), probeScope(type), nothing, refusalForm) };
  }
  if (!type.isOrdered) return { error: true };
  if (input.placement) return { anchor: repository.anchor(/** @type {NonNullable<ReturnType<typeof placementOf>>} */ (placementOf(input.placement))) };
  const move = new Move(new Id(input.move.id, type), recordID(input.move.below) === null ? null : new Id(input.move.below, type), ProbeRefusals, probeScope(type));
  return { decision: decisionForm(move.decide(move.load(reader)), probeScope(type), nothing, refusalForm) };
}

/** @param {any} input */
function capacityVector(input) {
  const views = vectorViews(input.records);
  const capacity = new Capacity(probeEntity(input.t), [...views.stored.values()], probeRegistry);
  return { used: capacity.used, cap: capacity.cap, full: capacity.isFull };
}

/** @param {string} name */
function draftable(name) {
  const type = probeEntity(name);
  if (!type.isDraftable) throw new ContractError(`${name} is no probe draftable`);
  return type;
}

/** @param {any} input */
function saveVector(input) {
  const form = input.draft ?? input.creating;
  const type = draftable(form.t);
  const save = input.draft
    ? SaveDraft.ofDraft((form.isNew ? Draft.new(probeValue(type, form.id, form.base ?? {}), placementOf(form.placement), probeScope(type)) : Draft.opening(probeValue(type, form.id, form.base ?? {}), probeScope(type)))
      .edit(() => probeValue(type, form.id, form.current ?? {})), ProbeRefusals)
    : SaveDraft.creating(probeValue(type, form.id, form.f ?? {}), ProbeRefusals, placementOf(form.placement), probeScope(type));
  const views = vectorViews({ drawn: input.drawn, stored: input.stored });
  const loaded = { ...save.load(new Reader(views, probeScope(type), momentOf(input))), anchor: recordID(input.anchor) };
  return { decision: decisionForm(decision(save, loaded, new IDSource(views)), probeScope(type), savedForm, refusalForm) };
}

/** @param {any} input */
async function scriptVector(input) {
  const type = draftable(input.t);
  const at = momentOf(input);
  const replica = new VectorReplica({ drawn: input.drawn, stored: input.stored }, at.now.ms);
  const runner = new ActionRunner(replica, probeRegistry, at.zone);
  replica.scopes = input.scopes ?? {};
  const remembered = new Map();
  /** @type {Draft<import('./probe.js').ProbeEntity> | null} */
  let draft = null;
  /** @type {Json[]} */
  const steps = [];
  const held = () => {
    if (draft === null) throw new ContractError('the script holds no draft');
    return draft;
  };
  for (const operation of input.ops) {
    /** @type {{ [key: string]: Json }} */
    const step = {};
    const id = recordID(operation.id);
    const scope = operation.scope ?? input.scope ?? probeScope(type);
    try {
      switch (operation.op) {
        case 'new':
          draft = Draft.new(probeValue(type, id), placementOf(operation.placement), scope);
          break;
        case 'open':
          draft = runner.open(type, new Id(id, type), scope);
          break;
        case 'openOrNew':
          draft = runner.openOrNew(type, new Id(id, type), probeValue(type, recordID(operation.blank) ?? id), scope);
          break;
        case 'edit':
          draft = held().edit((current) => probeValue(type, current.id.record, { ...current.fields(), ...operation.f }));
          break;
        case 'save': {
          let saving = held();
          if (operation.as) saving = saving.edit((current) => probeValue(type, operation.as, current.fields()));
          if (operation.fail) replica.failNext = true;
          const before = replica.gestures.length;
          const saved = await runner.save(saving, ProbeRefusals, operation.scope ?? saving.scope);
          draft = saved.draft;
          const result = saved.result;
          /** @type {{ [key: string]: Json }} */
          const form = result.kind === 'saved' ? { saved: result.receipt?.gestureId ?? null }
            : result.kind === 'refused' ? { refused: refusalForm(result.refusal) } : { failed: true };
          if (operation.gesture) form.gesture = /** @type {Json} */ (/** @type {unknown} */ (replica.gestures[before] ?? null));
          if (input.reportScope) form.scope = replica.commitScopes[before] ?? null;
          step.result = form;
          break;
        }
        case 'rebase':
          draft = held().rebased(probeValue(type, id ?? held().id.record, operation.f ?? {}));
          break;
        case 'load':
          runner.read(scope, (read) => SaveDraft.ofDraft(held(), ProbeRefusals).load(read));
          break;
        case 'remember':
          remembered.set(operation.name, held());
          break;
        case 'recall':
          draft = remembered.get(operation.name);
          break;
        case 'records':
          replica.records = { drawn: operation.drawn, stored: operation.stored };
          break;
        default:
          throw new ContractError(`unknown script operation ${operation.op}`);
      }
      step.draft = draft === null ? null : { ...draftForm(draft), ...(input.reportScope ? { scope: draft.scope } : {}) };
      steps.push(step);
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      steps.push({ trap: true });
      break;
    }
  }
  return { steps };
}

/** @param {any} input */
function subjectVector(input) {
  if (input.source === 'commit') {
    const subject = refusalSubject(build(input, momentOf(input)), input.code, input.detail ?? null, probeRegistry);
    return { subject: subject === null ? null : { t: subject.t, id: subject.id } };
  }
  const notice = new DomainNotice(input.notice, probeRegistry, ProbeRefusals);
  /** @type {{ [key: string]: Json }} */
  const form = { subject: notice.subject === null ? null : { t: notice.subject.t, id: notice.subject.id }, gestureId: notice.gestureId };
  if (input.of) form.values = notice.values({ t: input.of.t, id: input.of.id });
  return form;
}

// §9.5 an act's decision as ProductCorpus.act gives it to a product's vectors: each scope of `loads` read for the ids
// it draws, which is the result, and each segment built as in plan/translate.json, an operation with `mint` taking
// the next id in its segment's scope.
/** @param {any} input */
function actDecisionVector(input) {
  const corpus = new ProductCorpus(new RuleBook(probeRegistry, [], []), () => null);
  /** @type {import('../../../src/platform/domain-kit/acts.js').ActAction<{ moment: import('../../../src/platform/domain-kit/time.js').Moment, drawn: Json }, Json, ProbeRefusal>} */
  const act = {
    refusals: ProbeRefusals,
    load: (read) => ({
      moment: read.moment,
      drawn: Object.fromEntries((input.loads ?? []).map((/** @type {string} */ scope) => [scope,
        read.inScope(scope, (reader) => [...reader.views.drawn.values()].map((record) => record.id))])),
    }),
    decide: ({ moment, drawn }, ids) => {
      if (input.segments.length === 0) return ActDecision.unchanged(drawn);
      return ActDecision.write(new ActPlan(input.segments.map((/** @type {any} */ segment) => {
        const plan = segment.plan.map((/** @type {any} */ operation) => operation.mint ? { ...operation, id: ids.mint(probeEntity(operation.t), segment.scope).record } : operation);
        return new ScopedPlan(segment.scope, build({ ...segment, plan }, moment));
      })), drawn);
    },
  };
  return corpus.act(act, { file: 'domain-kit/run/act-decisions.json', name: '', input, expect: null }, (result) => result, refusalForm);
}

/** @type {Record<string, (input: any) => Json | Promise<Json>>} */
const handlers = {
  'value/text.json': valueVector,
  'value/number.json': valueVector,
  'value/choice.json': valueVector,
  'value/count.json': countVector,
  'time/day.json': dayVector,
  'order/list.json': listVector,
  'capacity/count.json': capacityVector,
  'plan/translate.json': translateVector,
  'run/pipeline.json': pipelineVector,
  'run/acts.json': actVector,
  'run/act-decisions.json': actDecisionVector,
  'run/composed.json': engineActVector,
  'run/undo.json': engineActVector,
  'draft/save.json': saveVector,
  'draft/script.json': scriptVector,
  'scope/bindings.json': scriptVector,
  'refusal/subject.json': subjectVector,
};

// `{error: true}` expects a failure the kit or the contract raises; any other throw is a defect.
/** @param {unknown} error */
const isExpectedFailure = (error) => error instanceof PlanError || error instanceof Violation || error instanceof DecodeError
  || error instanceof Fault || error instanceof ContractError;

/**
 * @param {(input: any) => Json | Promise<Json>} handler
 * @param {import('./vectors.js').Vector} vector
 * @param {any} input
 * @param {string} label
 */
async function check(handler, vector, input, label) {
  const expectsError = jcs(vector.expect) === jcs({ error: true });
  let actual;
  try {
    actual = await handler(input);
  } catch (error) {
    if (expectsError && isExpectedFailure(error)) return;
    throw new assert.AssertionError({ message: `${label}: ${error instanceof Error ? error.stack : String(error)}` });
  }
  assert.equal(jcs(actual), jcs(vector.expect), label);
}

const files = Contract.files(DIRECTORY);
let total = 0;

for (const file of files) {
  const handler = handlers[file.slice(DIRECTORY.length + 1)];
  if (!handler) continue;
  const vectors = Contract.vectors(file);
  total += vectors.length;
  test(`kit corpus ${file}`, async () => {
    for (const vector of vectors) {
      await check(handler, vector, vector.input, `${file} · ${vector.name}`);
      if (listsRecords(vector.input)) await check(handler, vector, withRecordsReversed(vector.input), `${file} · ${vector.name} · records reversed`);
    }
  });
}

test('every kit corpus file is claimed and every handler has a file', (/** @type {import('node:test').TestContext} */ t) => {
  const claimed = Object.keys(handlers).map((name) => `${DIRECTORY}/${name}`).sort();
  assert.deepEqual(files, claimed);
  t.diagnostic(`kit corpus: ${claimed.length}/${files.length} files, ${total} vectors`);
});
