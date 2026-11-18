// K-3 Undo of an act: the closed recipe union a plan opts in with, the fixed arguments of an engine
// `restore` command and of a product `inverse` command, and the one evaluation of restore operations the
// server admits. Slots and versions use E-7's encoding (§6.4); values never leave the device but in a
// restore's own arguments.

import { compareBytes, utf8 } from './encoding.js';
import { jcs, sameJson } from './jcs.js';
import { Stamp } from './stamp.js';
import { checkFieldValue, checkId, lengthIn } from './values.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, optional = []) => isObject(value)
  && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key))
  && keys.every((key) => Object.hasOwn(value, key));
const isSeq = (value) => Number.isSafeInteger(value) && value >= 0;

// The order E-7 lists a row's slots in: born, life, fields by name, texts by name.
function slotOrderKey(slot) {
  if (slot.kind === 'born') return '0';
  if (slot.kind === 'life') return '1';
  return `${slot.kind === 'field' ? '2' : '3'}${slot.name}`;
}

export function sameSlot(a, b) {
  return a.kind === b.kind && (a.name ?? null) === (b.name ?? null);
}

export function sameRecord(a, b) {
  return a.scope === b.scope && a.t === b.t && sameJson(a.id, b.id);
}

function targetKey({ scope, t, id, slot }) {
  return jcs([scope, t, id, slot.kind, slot.name ?? null]);
}

function slotShapeFault(slot) {
  if (!isObject(slot)) return 'a slot is an object';
  if (slot.kind === 'born' || slot.kind === 'life') return exactKeys(slot, ['kind']) ? null : 'a born or life slot names no field';
  if (slot.kind === 'field' || slot.kind === 'text') return exactKeys(slot, ['kind', 'name']) && typeof slot.name === 'string' ? null : 'a field or text slot names its field';
  return 'an unknown slot kind';
}

// A slot a generic restore may write back (§6.4 restore): a client-written lww register, a client text, or
// the life of a record a write can bring back, keyed with life or revivable. Never born, server or const.
export function restorableSlotFault(type, slot) {
  const fault = slotShapeFault(slot);
  if (fault) return fault;
  if (slot.kind === 'born') return 'born is never restored';
  if (slot.kind === 'life') return type.life && (type.identity === 'keyed' || type.revivable) ? null : `${type.type} life cannot be restored`;
  const field = type.field(slot.name);
  if (slot.kind === 'field') return field?.kind === 'lww' && field.writer === 'client' ? null : `${type.type}.${slot.name} is not a client lww register`;
  return field?.kind === 'text' && field.writer === 'client' ? null : `${type.type}.${slot.name} is not a client text`;
}

// A record a strict creation recipe may delete again: a type with life that governs no tree and is not saved whole.
export function creatableFault(type) {
  if (!type.life) return `${type.type} has no life`;
  if (type.governs) return `${type.type} governs a tree: its creation is undone by a product command`;
  if (type.wholePut) return `${type.type} is saved whole`;
  return null;
}

export function logicalValueFault(registry, type, slot, value) {
  if (slot.kind === 'life') return value === 'alive' || value === 'dead' ? null : 'a life is alive or dead';
  const field = type.field(slot.name);
  if (slot.kind === 'text') {
    if (typeof value !== 'string') return 'a text is a string';
    return field.max !== undefined && lengthIn(field.unit, value) > field.max ? 'a text over its bound' : null;
  }
  return checkFieldValue(registry, field, value);
}

function versionFault(slot, version) {
  if (slot.kind === 'text') return exactKeys(version, ['kind', 'revision']) && version.kind === 'text' && Number.isSafeInteger(version.revision) && version.revision > 0 ? null : 'a text version is its revision';
  return exactKeys(version, ['kind', 'stamp']) && version.kind === 'stamp' && Stamp.isValid(version.stamp) && version.stamp !== Stamp.UNSET ? null : 'a version is a stamp';
}

// The E-7 version a slot of a stored row carries now, or null when the register is unset.
export function versionIn(row, slot) {
  if (!row) return null;
  if (slot.kind === 'born') return row.born === undefined ? null : { kind: 'stamp', stamp: row.born };
  if (slot.kind === 'life') return row.life ? { kind: 'stamp', stamp: row.life[1] } : null;
  if (slot.kind === 'field') return row.f?.[slot.name] ? { kind: 'stamp', stamp: row.f[slot.name][1] } : null;
  return row.x?.[slot.name] ? { kind: 'text', revision: row.x[slot.name].rev } : null;
}

// The logical value a slot of a stored row or a view record reads (a view's text is its string), or
// undefined when unset.
export function valueIn(row, slot) {
  if (!row) return undefined;
  if (slot.kind === 'life') return row.life?.[0];
  if (slot.kind === 'field') return row.f?.[slot.name]?.[0];
  const text = row.x?.[slot.name];
  return typeof text === 'string' ? text : text?.text;
}

export function compareSlots(a, b) {
  return compareBytes(utf8(slotOrderKey(a)), utf8(slotOrderKey(b)));
}

// A stored row's complete versioned footprint, in E-7's slot order.
export function footprintOf(row) {
  const slots = [];
  for (const slot of [{ kind: 'born' }, { kind: 'life' }, ...Object.keys(row.f ?? {}).map((name) => ({ kind: 'field', name })),
    ...Object.keys(row.x ?? {}).map((name) => ({ kind: 'text', name }))]) {
    const version = versionIn(row, slot);
    if (version) slots.push({ slot, version });
  }
  return slots.sort((a, b) => compareSlots(a.slot, b.slot));
}

function footprintFault(type, footprint) {
  if (!Array.isArray(footprint) || footprint.length === 0) return 'a footprint lists slots';
  let previous = null;
  for (const item of footprint) {
    if (!exactKeys(item, ['slot', 'version'])) return 'a footprint slot is {slot, version}';
    const fault = slotShapeFault(item.slot) ?? versionFault(item.slot, item.version);
    if (fault) return fault;
    if (item.slot.kind === 'born' ? !type.hasBorn : item.slot.kind === 'life' ? !type.life
      : item.slot.kind === 'field' ? !type.field(item.slot.name) || type.field(item.slot.name).kind === 'text' || type.field(item.slot.name).kind === 'serial'
        : type.field(item.slot.name)?.kind !== 'text') return 'a footprint slot outside its type';
    if (previous && compareSlots(previous, item.slot) >= 0) return 'a footprint is in slot order';
    previous = item.slot;
  }
  return null;
}

// The registry scope kind a ScopeRef names, a tree or overlay naming a governing id, or null.
function scopeKindOfRef(registry, ref) {
  const kind = registry.scopeKindOf(ref);
  if (!kind || kind === 'device') return null;
  if ((kind === 'tree' || kind === 'overlay') && (!registry.governingType || checkId(registry, registry.governingType, ref.split('/').pop()))) return null;
  return kind;
}

// UndoRecipe, the closed union a plan opts in with, checked against the segment's scope (§7.1 K-3).
export function recipeFault(registry, scope, recipe) {
  const kind = registry.scopeKindOf(scope);
  const restore = (name) => registry.command(name)?.engine === 'restore' && registry.command(name).scope === kind;
  const addressFault = (address, needsLife) => {
    if (!exactKeys(address, ['scope', 't', 'id'], needsLife === 'target' ? ['slot'] : [])) return 'an address is {scope, t, id}';
    const type = registry.type(address.t);
    if (!type || type.scope !== scopeKindOfRef(registry, address.scope)) return `${address.t} does not live in ${address.scope}`;
    return checkId(registry, type, address.id);
  };
  if (!isObject(recipe)) return 'a recipe is an object';
  switch (recipe.kind) {
    case 'fields': {
      if (!exactKeys(recipe, ['kind', 'restoreCommand', 'targets']) || !restore(recipe.restoreCommand)) return 'a fields recipe names its scope kind\'s restore command';
      if (!Array.isArray(recipe.targets) || recipe.targets.length === 0) return 'a fields recipe lists targets';
      for (const item of recipe.targets) {
        if (!exactKeys(item, ['target'], ['defaultValue']) || !exactKeys(item.target, ['scope', 't', 'id', 'slot'])) return 'a target is {target, defaultValue?}';
        if (item.target.scope !== scope) return 'a generic target lives in its segment scope';
        const fault = addressFault(item.target, 'target');
        if (fault) return fault;
        const type = registry.type(item.target.t);
        if (!registry.command(recipe.restoreCommand).predicts?.includes(type.type)) return `${recipe.restoreCommand} restores no ${type.type}`;
        const slotFault = restorableSlotFault(type, item.target.slot);
        if (slotFault) return slotFault;
        if (Object.hasOwn(item, 'defaultValue') && logicalValueFault(registry, type, item.target.slot, item.defaultValue)) return 'a default off its slot domain';
      }
      return null;
    }
    case 'createdRecord': {
      if (!exactKeys(recipe, ['kind', 'restoreCommand', 'record']) || !restore(recipe.restoreCommand)) return 'a created record recipe names its scope kind\'s restore command';
      if (recipe.record?.scope !== scope) return 'a created record lives in its segment scope';
      const fault = addressFault(recipe.record);
      if (fault) return fault;
      if (!registry.command(recipe.restoreCommand).predicts?.includes(recipe.record.t)) return `${recipe.restoreCommand} restores no ${recipe.record.t}`;
      return creatableFault(registry.type(recipe.record.t));
    }
    case 'command': {
      if (!exactKeys(recipe, ['kind', 'command', 'input', 'evidence'])) return 'a command recipe is {command, input, evidence}';
      const command = registry.command(recipe.command);
      if (!command?.inverse || command.scope !== kind) return `${recipe.command} is no inverse command of ${kind}`;
      const { evidence } = recipe;
      if (!exactKeys(evidence, ['ownedFields', 'unchangedCreatedRecords', 'unchangedCreatedScopes'])
        || ![evidence.ownedFields, evidence.unchangedCreatedRecords, evidence.unchangedCreatedScopes].every(Array.isArray)) return 'evidence selects owned fields, created records and created scopes';
      for (const target of evidence.ownedFields) {
        const fault = !exactKeys(target, ['scope', 't', 'id', 'slot']) ? 'an owned field is a target' : addressFault(target, 'target') ?? slotShapeFault(target.slot);
        if (fault) return fault;
      }
      for (const record of evidence.unchangedCreatedRecords) {
        const fault = addressFault(record);
        if (fault) return fault;
        if (!registry.type(record.t).life) return `${record.t} has no life`;
      }
      for (const created of evidence.unchangedCreatedScopes) {
        if (!['tree', 'overlay'].includes(scopeKindOfRef(registry, created))) return 'a created scope is a tree or an overlay';
      }
      return null;
    }
    default:
      return 'an unknown recipe';
  }
}

// The fixed arguments of an engine restore command, checked at admission and before a commit (§6.4).
export function restoreArgumentsFault(registry, command, args) {
  if (!exactKeys(args, ['expectedEpoch', 'operations'])) return 'restore arguments are {expectedEpoch, operations}';
  if (typeof args.expectedEpoch !== 'string' || args.expectedEpoch.length === 0) return 'an expected epoch';
  if (!Array.isArray(args.operations) || args.operations.length === 0) return 'a restore restores something';
  const seen = new Set();
  for (const op of args.operations) {
    if (!isObject(op)) return 'an operation is an object';
    const type = registry.type(op.t);
    if (!type || !command.predicts?.includes(op.t)) return `${command.name} restores no ${op.t}`;
    const idFault = checkId(registry, type, op.id);
    if (idFault) return idFault;
    switch (op.kind) {
      case 'field': {
        if (!exactKeys(op, ['kind', 't', 'id', 'slot', 'expected', 'before'])) return 'a field operation is {t, id, slot, expected, before}';
        const fault = restorableSlotFault(type, op.slot) ?? logicalValueFault(registry, type, op.slot, op.before);
        if (fault) return fault;
        if (op.expected?.kind === 'absent') {
          if (!exactKeys(op.expected, ['kind', 'born']) || op.slot.kind === 'life') return 'an absent expectation names a birth and a field';
          if (type.hasBorn ? !Stamp.isValid(op.expected.born) || op.expected.born === Stamp.UNSET : op.expected.born !== null) return 'an absent expectation names the record birth';
        } else {
          const versionError = versionFault(op.slot, op.expected);
          if (versionError) return versionError;
        }
        const key = targetKey({ scope: '', t: op.t, id: op.id, slot: op.slot });
        if (seen.has(key)) return 'one operation per slot';
        seen.add(key);
        break;
      }
      case 'createdRecord': {
        if (!exactKeys(op, ['kind', 't', 'id', 'rowSeq', 'footprint'])) return 'a created record operation is {t, id, rowSeq, footprint}';
        const fault = creatableFault(type) ?? footprintFault(type, op.footprint);
        if (fault) return fault;
        if (!isSeq(op.rowSeq) || op.rowSeq === 0) return 'a row sequence';
        break;
      }
      case 'createRecord': {
        if (!exactKeys(op, ['kind', 't', 'id', 'values'])) return 'a create operation is {t, id, values}';
        const fault = creatableFault(type) ?? creationValuesFault(registry, type, op.values);
        if (fault) return fault;
        break;
      }
      default:
        return 'an unknown restore operation';
    }
  }
  return null;
}

function creationValuesFault(registry, type, values) {
  if (!exactKeys(values, [], ['f', 'x'])) return 'creation values are {f?, x?}';
  for (const [name, value] of Object.entries(values.f ?? {})) {
    const field = type.field(name);
    if (!field || field.writer !== 'client' || !['lww', 'fww', 'const', 'time'].includes(field.kind)) return `${type.type}.${name} is not a client value`;
    const fault = checkFieldValue(registry, field, value);
    if (fault) return fault;
  }
  for (const [name, text] of Object.entries(values.x ?? {})) {
    const field = type.field(name);
    if (field?.kind !== 'text' || field.writer !== 'client' || typeof text !== 'string') return `${type.type}.${name} is not a client text`;
    if (field.max !== undefined && lengthIn(field.unit, text) > field.max) return 'a text over its bound';
  }
  return null;
}

// The engine-built evidence of a product inverse command (§6.4): the epoch, the latest accepted versions it
// owns, and the receipts that prove its created records and scopes unchanged since.
export function evidenceFault(registry, evidence) {
  if (!exactKeys(evidence, ['expectedEpoch', 'ownedFields', 'unchangedCreatedRecords', 'unchangedCreatedScopes'])) return 'evidence is {expectedEpoch, ownedFields, unchangedCreatedRecords, unchangedCreatedScopes}';
  if (typeof evidence.expectedEpoch !== 'string' || evidence.expectedEpoch.length === 0) return 'an expected epoch';
  const address = (value, keys) => {
    if (!exactKeys(value, keys)) return 'an address';
    const type = registry.type(value.t);
    if (!type || type.scope !== scopeKindOfRef(registry, value.scope)) return 'an address in its scope';
    return checkId(registry, type, value.id);
  };
  if (!Array.isArray(evidence.ownedFields)) return 'owned fields';
  for (const item of evidence.ownedFields) {
    if (!exactKeys(item, ['target', 'version'])) return 'an owned field is {target, version}';
    const fault = address(item.target, ['scope', 't', 'id', 'slot']) ?? slotShapeFault(item.target.slot) ?? versionFault(item.target.slot, item.version);
    if (fault) return fault;
  }
  if (!Array.isArray(evidence.unchangedCreatedRecords)) return 'created records';
  for (const item of evidence.unchangedCreatedRecords) {
    if (!exactKeys(item, ['record', 'rowSeq', 'footprint'])) return 'a created record is {record, rowSeq, footprint}';
    const fault = address(item.record, ['scope', 't', 'id']) ?? (isSeq(item.rowSeq) && item.rowSeq > 0 ? null : 'a row sequence')
      ?? footprintFault(registry.type(item.record.t), item.footprint);
    if (fault) return fault;
  }
  if (!Array.isArray(evidence.unchangedCreatedScopes)) return 'created scopes';
  for (const item of evidence.unchangedCreatedScopes) {
    if (!exactKeys(item, ['scope', 'seq']) || !['tree', 'overlay'].includes(scopeKindOfRef(registry, item.scope)) || !isSeq(item.seq)) return 'a created scope is {scope, seq}';
  }
  return null;
}

// One restore command's operations against the scope's stored rows, in order: each holds or skips by its own
// condition, and the operations that hold become one server delta a record, stamped at admission (§10.3).
// `stored(t, id)` reads the row as stored, `spent(t, id)` whether a spent id holds it, `epoch` the server's.
export function evaluateRestore(registry, { stored, spent, epoch }, args) {
  const outcomes = [];
  const records = new Map();
  const working = (t, id) => {
    const key = jcs([t, id]);
    if (!records.has(key)) records.set(key, { t, id, row: stored(t, id) ?? null, delta: null });
    return records.get(key);
  };
  const deltaOf = (record) => {
    if (record.delta) return record.delta;
    const type = registry.type(record.t);
    record.delta = { t: record.t, id: record.id };
    if (type.hasBorn) record.delta.born = record.row.born;
    if (type.life && (type.identity === 'keyed' || record.row.life?.[0] === 'dead')) record.delta.life = record.row.life;
    return record.delta;
  };
  args.operations.forEach((op, index) => {
    const skip = (code) => outcomes.push({ index, s: 'skipped', code });
    if (args.expectedEpoch !== epoch) return skip('epoch-changed');
    const type = registry.type(op.t);
    const record = working(op.t, op.id);
    const { row } = record;
    if (op.kind === 'field') {
      if (op.expected.kind === 'absent') {
        if (!row || (type.hasBorn && row.born !== op.expected.born) || versionIn(row, op.slot) !== null) return skip('version-changed');
      } else if (!sameJson(versionIn(row, op.slot), op.expected)) return skip('version-changed');
      if (op.slot.kind !== 'life' && type.life && row.life?.[0] !== 'alive' && !type.revivable && type.identity !== 'keyed') return skip('record-dead');
      const delta = deltaOf(record);
      if (op.slot.kind === 'life') delta.life = [op.before, null];
      else if (op.slot.kind === 'field') delta.f = { ...delta.f, [op.slot.name]: [op.before, null] };
      else delta.x = { ...delta.x, [op.slot.name]: { text: op.before, replace: true, archiveNonempty: false, archive: {} } };
      outcomes.push({ index, s: 'applied' });
      return undefined;
    }
    if (op.kind === 'createdRecord') {
      if (!row || row.life?.[0] !== 'alive' || row.seq !== op.rowSeq || !sameJson(footprintOf(row), op.footprint)) return skip('record-changed');
      deltaOf(record).life = ['dead', null];
      outcomes.push({ index, s: 'applied' });
      return undefined;
    }
    if (row || record.delta || spent(op.t, op.id)) return skip('record-present');
    record.delta = { t: op.t, id: op.id, life: ['alive', null], ...(type.hasBorn ? { born: null } : {}) };
    if (op.values.f && Object.keys(op.values.f).length) record.delta.f = Object.fromEntries(Object.entries(op.values.f).map(([name, value]) => [name, [value, null]]));
    if (op.values.x && Object.keys(op.values.x).length) record.delta.x = Object.fromEntries(Object.entries(op.values.x).map(([name, text]) => [name, { text, base: { rev: 0 } }]));
    outcomes.push({ index, s: 'applied' });
    return undefined;
  });
  return { deltas: [...records.values()].filter((record) => record.delta).map((record) => record.delta), outcomes };
}

// The first condition a product inverse command's evidence breaks against the scopes as stored, or null:
// another epoch, an owned field another write moved, a created record or created scope changed since.
// `row(scope, t, id)` reads a stored row and `seq(scope)` a scope's sequence, both by ScopeRef.
export function evidenceSkip({ row, seq, epoch }, evidence) {
  if (evidence.expectedEpoch !== epoch) return 'epoch-changed';
  for (const { target, version } of evidence.ownedFields) {
    if (!sameJson(versionIn(row(target.scope, target.t, target.id), target.slot), version)) return 'version-changed';
  }
  for (const { record, rowSeq, footprint } of evidence.unchangedCreatedRecords) {
    const current = row(record.scope, record.t, record.id);
    if (!current || current.life?.[0] !== 'alive' || current.seq !== rowSeq || !sameJson(footprintOf(current), footprint)) return 'record-changed';
  }
  for (const created of evidence.unchangedCreatedScopes) if (seq(created.scope) !== created.seq) return 'scope-changed';
  return null;
}

export class InverseOutcomesError extends Error {}

// The outcomes a restore or inverse command reports in its command detail: one per operation, in order.
export function inverseOutcomes(detail, count) {
  const outcomes = detail?.inverse?.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length !== count) throw new InverseOutcomesError('an inverse result reports each operation');
  outcomes.forEach((outcome, index) => {
    const applied = exactKeys(outcome, ['index', 's']) && outcome.s === 'applied';
    const skipped = exactKeys(outcome, ['index', 's', 'code']) && outcome.s === 'skipped' && typeof outcome.code === 'string';
    if (outcome.index !== index || (!applied && !skipped)) throw new InverseOutcomesError('an inverse outcome is applied or skipped with a code');
  });
  return outcomes;
}
