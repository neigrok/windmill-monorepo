// @ts-check
// The kit corpus (§15.2): every file under packages/api-contract/domain-kit has a handler here, every
// handler a file, and every vector reproduces its `expect` byte for byte by JCS. Each vector that lists
// records runs again with them reversed.

import assert from 'node:assert/strict';
import test from 'node:test';
import { jcs } from '../../../src/platform/sync/core/jcs.js';
import { Decision, IDSource, decision, refusalSubject } from '../../../src/platform/domain-kit/actions.js';
import { Draft, SaveDraft } from '../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id } from '../../../src/platform/domain-kit/entities.js';
import { Plan, PlanError, Prediction } from '../../../src/platform/domain-kit/plans.js';
import { Capacity, Reader } from '../../../src/platform/domain-kit/reading.js';
import { DomainNotice } from '../../../src/platform/domain-kit/refusals.js';
import { ActionRunner } from '../../../src/platform/domain-kit/runner.js';
import { Move, Remove } from '../../../src/platform/domain-kit/standardActions.js';
import { Instant, LocalDay } from '../../../src/platform/domain-kit/time.js';
import { translate } from '../../../src/platform/domain-kit/translation.js';
import { Valid } from '../../../src/platform/domain-kit/validation.js';
import { CountSpec, Fault, Path, TextSpec, Violation } from '../../../src/platform/domain-kit/values.js';
import { PROBE_SCOPE, ProbeRefusals, probeCommand, probeEntity, probeValue, refusalForm } from './probe.js';
import { Contract, ContractError, VectorReplica, applySpec, decisionForm, draftForm, listsRecords, momentOf, outcomeForm, placementOf,
  probeRegistry, savedForm, specOf, vectorViews, withRecordsReversed } from './vectors.js';

/** @typedef {import('../../../src/platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./probe.js').ProbeRefusal} ProbeRefusal */

const DIRECTORY = 'domain-kit';
const nothing = () => /** @type {Json} */ (null);

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
    return prediction.op === 'create' ? Prediction.create(id, prediction.f ?? {}) : Prediction.update(id, prediction.f ?? {});
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
    return { gesture: /** @type {Json} */ (/** @type {unknown} */ (translate(build(input, momentOf(input)), input.scope ?? PROBE_SCOPE, probeRegistry))) };
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
  const replica = new VectorReplica({ drawn: input.drawn, stored: input.stored ?? input.drawn }, moment.now.ms, answerOf(input));
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
function listVector(input) {
  const type = probeEntity(input.t);
  const views = vectorViews(input.records);
  const reader = new Reader(views, type.scope, momentOf(input));
  const repository = reader.repository(type);
  const ids = (/** @type {{ id: Id<any> }[]} */ entities) => entities.map((entity) => entity.id.json);
  if (input.view) return { ids: ids(repository.all(input.view)) };
  if (input.children) return { ids: ids(repository.children(new Id(input.children.of, type), input.children.via, input.children.view ?? 'drawn')) };
  if (input.remove) {
    if (!type.isRemovable) return { error: true };
    const remove = new Remove(new Id(input.remove.id, type), ProbeRefusals);
    return { decision: decisionForm(remove.decide(remove.load(reader)), type.scope, nothing, refusalForm) };
  }
  if (!type.isOrdered) return { error: true };
  if (input.placement) return { anchor: repository.anchor(/** @type {NonNullable<ReturnType<typeof placementOf>>} */ (placementOf(input.placement))) };
  const move = new Move(new Id(input.move.id, type), recordID(input.move.below) === null ? null : new Id(input.move.below, type), ProbeRefusals);
  return { decision: decisionForm(move.decide(move.load(reader)), type.scope, nothing, refusalForm) };
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
    ? SaveDraft.ofDraft((form.isNew ? Draft.new(probeValue(type, form.id, form.base ?? {}), placementOf(form.placement)) : Draft.opening(probeValue(type, form.id, form.base ?? {})))
      .edit(() => probeValue(type, form.id, form.current ?? {})), ProbeRefusals)
    : SaveDraft.creating(probeValue(type, form.id, form.f ?? {}), ProbeRefusals, placementOf(form.placement));
  const views = vectorViews({ drawn: input.drawn, stored: input.stored });
  const repository = new Reader(views, type.scope, momentOf(input)).repository(type);
  const folded = repository.record(form.id, 'stored');
  const loaded = {
    drawn: repository.find(save.id, 'drawn'),
    stored: repository.find(save.id, 'stored'),
    folded: folded ? type.decode(Fields.record(folded)) : null,
    anchor: recordID(input.anchor),
    moment: momentOf(input),
    definition: /** @type {NonNullable<ReturnType<typeof probeRegistry.type>>} */ (probeRegistry.type(type.type)),
  };
  return { decision: decisionForm(decision(save, loaded, new IDSource(views)), type.scope, savedForm, refusalForm) };
}

/** @param {any} input */
async function scriptVector(input) {
  const type = draftable(input.t);
  const at = momentOf(input);
  const replica = new VectorReplica({ drawn: input.drawn, stored: input.stored }, at.now.ms);
  const runner = new ActionRunner(replica, probeRegistry, at.zone);
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
    try {
      switch (operation.op) {
        case 'new':
          draft = Draft.new(probeValue(type, id), placementOf(operation.placement));
          break;
        case 'open':
          draft = runner.open(type, new Id(id, type));
          break;
        case 'openOrNew':
          draft = runner.openOrNew(type, new Id(id, type), probeValue(type, recordID(operation.blank) ?? id));
          break;
        case 'edit':
          draft = held().edit((current) => probeValue(type, current.id.record, { ...current.fields(), ...operation.f }));
          break;
        case 'save': {
          let saving = held();
          if (operation.as) saving = saving.edit((current) => probeValue(type, operation.as, current.fields()));
          if (operation.fail) replica.failNext = true;
          const before = replica.gestures.length;
          const saved = await runner.save(saving, ProbeRefusals);
          draft = saved.draft;
          const result = saved.result;
          /** @type {{ [key: string]: Json }} */
          const form = result.kind === 'saved' ? { saved: result.receipt?.gestureId ?? null }
            : result.kind === 'refused' ? { refused: refusalForm(result.refusal) } : { failed: true };
          if (operation.gesture) form.gesture = /** @type {Json} */ (/** @type {unknown} */ (replica.gestures[before] ?? null));
          step.result = form;
          break;
        }
        case 'rebase':
          draft = held().rebased(probeValue(type, id ?? held().id.record, operation.f ?? {}));
          break;
        case 'records':
          replica.records = { drawn: operation.drawn, stored: operation.stored };
          break;
        default:
          throw new ContractError(`unknown script operation ${operation.op}`);
      }
      step.draft = draft === null ? null : draftForm(draft);
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
  'draft/save.json': saveVector,
  'draft/script.json': scriptVector,
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
