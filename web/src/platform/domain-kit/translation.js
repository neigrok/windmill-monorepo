// @ts-check
// §8.2 translation: a plan becomes one engine gesture by the registry's identity classes, and §8.3's
// rules fail it as a PlanError. Every collection built from a set is ordered by bytes.

import { compareJcs, jcs } from '../sync/core/jcs.js';
import { Registry } from '../sync/core/registry.js';
import { recordKey } from '../sync/core/rows.js';
import { compareText, uniqueInByteOrder } from './entities.js';
import { PlanError } from './plans.js';

/** @typedef {import('./values.js').Json} Json */
/** @typedef {import('./entities.js').RecordID} RecordID */
/** @typedef {import('./entities.js').RecordRef} RecordRef */
/** @typedef {import('./plans.js').Plan} Plan */
/** @typedef {import('./plans.js').Operation} Operation */
/** @typedef {{ t: string, id: RecordID, field: string }} RegisterRef */
/** @typedef {{ text: string, from: string }} TextEdit */
/**
 * The engine's change language (engine corpus "Changes"), one change per plan operation.
 * @typedef {{ op: 'create' | 'update' | 'delete' | 'put' | 'write' | 'move', t: string, id: RecordID, f?: Record<string, Json>,
 *   x?: Record<string, TextEdit>, present?: boolean | null, anchor?: { field: string, below: RecordID | null } }} Change
 */
/**
 * @typedef {{ changes: Change[], atomic: boolean, hold: boolean, guards: RegisterRef[], retire: RecordRef[],
 *   cmd: import('./plans.js').Command | null, predict: Change[], local: import('./plans.js').DeviceWrite[] }} Gesture
 */
/** @typedef {import('./entities.js').Definition} Definition */

// A singleton is written at its one id, whatever id the operation carries.
/**
 * @param {Operation} operation
 * @param {Registry} registry
 * @returns {RecordID}
 */
export function recordIdOf(operation, registry) {
  const definition = /** @type {Definition | undefined} */ (registry.type(operation.entity.type));
  return definition?.singletonId ?? operation.id;
}

/**
 * @param {Change} change
 * @param {Record<string, Json>} values
 * @param {Record<string, TextEdit>} texts
 */
function withParts(change, values, texts) {
  if (Object.keys(values).length) change.f = values;
  if (Object.keys(texts).length) change.x = texts;
  return change;
}

// Rule 6: a named field is a checked, client-written, non-serial field other than the order field.
// A text field edits from its base, "" when the base holds none.
/**
 * @param {Operation} operation
 * @param {readonly string[]} names
 * @param {Definition} definition
 * @param {Record<string, Json> | null} base
 */
function split(operation, names, definition, base) {
  /** @type {Record<string, Json>} */
  const values = {};
  /** @type {Record<string, TextEdit>} */
  const texts = {};
  for (const name of names) {
    const field = definition.fields[name];
    if (!field || field.writer !== 'client' || field.kind === 'serial' || name === operation.entity.orderField
      || !Object.hasOwn(operation.values, name) || !operation.checked.includes(name)) {
      throw new PlanError(6, `${operation.entity.type}.${name} is not a checked client field`);
    }
    const value = /** @type {Json} */ (operation.values[name]);
    if (field.kind !== 'text') {
      values[name] = value;
      continue;
    }
    const from = base?.[name] ?? '';
    if (typeof value !== 'string') throw new PlanError(6, `${operation.entity.type}.${name} holds no text`);
    if (typeof from !== 'string') throw new PlanError(6, `the base of ${operation.entity.type}.${name} holds no text`);
    texts[name] = { text: value, from };
  }
  return { values, texts };
}

// Rule 9: a whole type is written whole.
/**
 * @param {Definition} definition
 * @param {readonly string[]} names
 */
function checkWhole(definition, names) {
  if (definition.wholePut !== true) return;
  const missing = definition.clientLatticeFieldNames.filter((/** @type {string} */ name) => !names.includes(name));
  if (missing.length) throw new PlanError(9, `a whole write leaves out ${missing.join(', ')}`);
}

/**
 * @param {Operation} operation
 * @param {Definition} definition
 * @param {readonly string[]} names
 * @param {{ field: string, below: RecordID | null } | null} anchor
 * @param {Record<string, Json> | null} base
 * @param {Registry} registry
 * @returns {Change}
 */
function creation(operation, definition, names, anchor, base, registry) {
  checkWhole(definition, names);
  const { values, texts } = split(operation, names, definition, base);
  const minted = definition.identity === 'minted';
  if (anchor !== null && !minted) throw new PlanError(0, 'an anchored create names a non-minted type');
  if (!minted && names.length === 0) throw new PlanError(8, 'a keyed create writes no field');
  if (minted) {
    // §5.3: a nil time field is left to the engine, which stamps it with the commit's now.
    const written = Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== null || definition.fields[name]?.kind !== 'time'));
    const change = withParts({ op: 'create', t: operation.entity.type, id: operation.id }, written, texts);
    return anchor === null ? change : { ...change, anchor };
  }
  if (definition.identity === 'keyed' && definition.life) return withParts({ op: 'put', t: operation.entity.type, id: operation.id, present: true }, values, texts);
  return withParts({ op: 'write', t: operation.entity.type, id: recordIdOf(operation, registry) }, values, texts);
}

// One operation's change, by the §8.2 table; a guardRead writes nothing.
/**
 * @param {Operation} operation
 * @param {string} scope
 * @param {Registry} registry
 * @returns {Change | null}
 */
function changeOf(operation, scope, registry) {
  const { entity, kind } = operation;
  const definition = /** @type {Definition | undefined} */ (registry.type(entity.type));
  if (!definition) throw new PlanError(0, `the registry has no type ${entity.type}`);
  if (entity.scope !== scope || definition.scope !== registry.scopeKindOf(scope)) throw new PlanError(1, `${entity.type} lives outside ${scope}`);
  if (definition.identity === 'derived') throw new PlanError(0, 'the kit writes no derived type');
  const minted = definition.identity === 'minted';
  const keyedWithLife = definition.identity === 'keyed' && definition.life === true;
  switch (kind.op) {
    case 'create':
      if (entity.isOrdered || (kind.named !== null && minted)) throw new PlanError(4, 'create does not place an Ordered type, nor part of a minted one');
      return creation(operation, definition, kind.named ?? uniqueInByteOrder(Object.keys(operation.values)), null, kind.base, registry);
    case 'insert':
      if (entity.orderField === null) throw new PlanError(4, 'insert names an unordered type');
      return creation(operation, definition, uniqueInByteOrder(Object.keys(operation.values)), { field: entity.orderField, below: kind.below }, null, registry);
    case 'update': {
      if (kind.named.length === 0) throw new PlanError(8, 'an update names no field');
      for (const name of kind.named) {
        const field = definition.fields[name];
        if (field?.kind === 'const' || field?.kind === 'time') throw new PlanError(7, `an update names the ${field.kind} field ${name}`);
        if (field?.kind === 'text' && kind.base === null) throw new PlanError(7, `a text update of ${name} has no base`);
      }
      checkWhole(definition, kind.named);
      const { values, texts } = split(operation, kind.named, definition, kind.base);
      if (minted) return withParts({ op: 'update', t: entity.type, id: operation.id }, values, texts);
      if (keyedWithLife) return withParts({ op: 'put', t: entity.type, id: operation.id, present: null }, values, texts);
      return withParts({ op: 'write', t: entity.type, id: recordIdOf(operation, registry) }, values, texts);
    }
    case 'remove':
      if (minted) return { op: 'delete', t: entity.type, id: operation.id };
      if (keyedWithLife) return { op: 'put', t: entity.type, id: operation.id, present: false };
      throw new PlanError(0, `${entity.type} has no removable life`);
    case 'move':
      if (definition.identity === 'singleton') throw new PlanError(0, 'a singleton has no order');
      if (entity.orderField === null) throw new PlanError(0, `${entity.type} is unordered`);
      return { op: 'move', t: entity.type, id: operation.id, anchor: { field: entity.orderField, below: kind.below } };
    case 'guardRead':
      return null;
    default:
      throw new PlanError(0, `unknown operation ${/** @type {{ op: string }} */ (kind).op}`);
  }
}

/**
 * @param {readonly Operation[]} operations
 * @param {Registry} registry
 * @returns {RegisterRef[]}
 */
function guardsOf(operations, registry) {
  /** @type {Map<string, RegisterRef>} */
  const guards = new Map();
  for (const operation of operations) {
    const definition = /** @type {Definition | undefined} */ (registry.type(operation.entity.type));
    const isLattice = (/** @type {string} */ name) => Registry.isLattice(definition?.fields[name]?.kind);
    /** @type {readonly string[]} */
    let fields = [];
    if (operation.kind.op === 'update' && operation.kind.guarded) fields = operation.kind.named.filter(isLattice);
    if (operation.kind.op === 'guardRead') {
      fields = operation.kind.fields;
      if (fields.some((name) => !isLattice(name))) throw new PlanError(6, 'a guard names no lattice register');
    }
    for (const field of fields) {
      const guard = { t: operation.entity.type, id: recordIdOf(operation, registry), field };
      guards.set(jcs([guard.t, guard.id, guard.field]), guard);
    }
  }
  return [...guards.values()].sort((a, b) => compareText(a.t, b.t) || compareJcs(a.id, b.id) || compareText(a.field, b.field));
}

/**
 * @param {Plan} plan
 * @param {Registry} registry
 * @returns {Change[]}
 */
function predictionsOf(plan, registry) {
  return plan.predictions.map((prediction) => {
    const predicts = plan.command ? registry.command(plan.command.name)?.predicts ?? [] : [];
    if (!predicts.includes(prediction.type)) throw new PlanError(5, `the command does not predict ${prediction.type}`);
    const texts = Object.fromEntries(Object.entries(prediction.texts).map(([name, text]) => [name, { text, from: '' }]));
    switch (prediction.kind) {
      case 'create':
        return withParts({ op: 'create', t: prediction.type, id: prediction.id }, prediction.values, {});
      case 'update':
        return withParts({ op: 'update', t: prediction.type, id: prediction.id }, prediction.values, {});
      case 'write':
        return withParts({ op: 'write', t: prediction.type, id: prediction.id }, prediction.values, texts);
      default:
        return registry.type(prediction.type)?.identity === 'keyed'
          ? { op: 'put', t: prediction.type, id: prediction.id, present: false }
          : { op: 'delete', t: prediction.type, id: prediction.id };
    }
  });
}

/**
 * @param {Plan} plan
 * @param {string} scope
 * @param {Registry} registry
 * @returns {Gesture}
 */
export function translate(plan, scope, registry) {
  const operations = plan.operations;
  const changes = operations.map((operation) => changeOf(operation, scope, registry)).filter((change) => change !== null);
  const keys = operations.map((operation) => recordKey(operation.entity.type, recordIdOf(operation, registry)));
  if (new Set(keys).size !== keys.length) throw new PlanError(2, 'two operations name one record');
  const onlyHeldRemovals = operations.every((operation) => operation.kind.op === 'remove' && operation.entity.heldRemoval === true);
  if (plan.isHeld && (!onlyHeldRemovals || plan.command !== null || plan.predictions.length)) {
    throw new PlanError(3, 'a held plan contains more than held removals and device writes');
  }
  const retire = operations
    .filter((operation) => operation.creates && registry.type(operation.entity.type)?.identity === 'keyed' && registry.type(operation.entity.type)?.life === true)
    .map((operation) => operation.ref)
    .sort((a, b) => compareText(a.t, b.t) || compareJcs(a.id, b.id));
  return {
    changes,
    atomic: changes.length > 1,
    hold: plan.isHeld,
    guards: guardsOf(operations, registry),
    retire,
    cmd: plan.command,
    predict: predictionsOf(plan, registry),
    local: plan.deviceWrites.map((write) => ({ key: write.key, value: write.value })),
  };
}
