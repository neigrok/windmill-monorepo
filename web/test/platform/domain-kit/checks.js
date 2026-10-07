// @ts-check

import assert from 'node:assert/strict';
import { Fields } from '../../../src/platform/domain-kit/entities.js';
import { Refused } from '../../../src/platform/domain-kit/refusals.js';
import { jcs } from '../../../src/platform/sync/core/jcs.js';
import { checkDomain, isOnQuantum, lengthIn } from '../../../src/platform/sync/core/values.js';
import { Contract } from './vectors.js';

/** @typedef {import('../../../src/platform/domain-kit/rules.js').RuleBook} RuleBook */
/** @typedef {import('../../../src/platform/domain-kit/entities.js').EntityType<any>} EntityType */

export class CheckFailure extends Error {
  /** @param {string} check @param {number} step @param {string} path @param {string} reason */
  constructor(check, step, path, reason) {
    super(`${check} step ${step}, ${path}: ${reason}`);
    this.check = check;
    this.step = step;
    this.path = path;
  }
}

/** @param {number} step @param {string} path @param {string} reason @returns {never} */
function fail(step, path, reason) { throw new CheckFailure('RegistryCheck', step, path, reason); }

/** @param {any} domain @param {string} path @returns {{ path: string, domain: any }[]} */
function leaves(domain, path) {
  if (!domain) return [];
  if (domain.type === 'array') return leaves(domain.items, path);
  if (domain.type === 'object') return Object.entries(domain.properties).flatMap(([name, child]) => leaves(child, `${path}.${name}`));
  return [{ path, domain }];
}

/** @param {any} domain @returns {number | null} */
function largestEncoding(domain) {
  /** @type {number | null} */
  let size = null;
  if (domain.type === 'boolean') size = 5;
  if (domain.type === 'number') size = domain.integer && domain.min !== undefined && domain.max !== undefined ? Math.max(jcs(domain.min).length, jcs(domain.max).length) : 24;
  if (domain.type === 'string') size = domain.enum ? Math.max(...domain.enum.map((/** @type {string} */ value) => lengthIn('bytes', jcs(value)))) : domain.max === undefined ? null : 2 + 6 * domain.max;
  if (domain.type === 'array') {
    const item = largestEncoding(domain.items);
    if (item !== null && domain.maxItems !== undefined) size = 2 + item * domain.maxItems + Math.max(domain.maxItems - 1, 0);
  }
  if (domain.type === 'object') {
    size = 2 + Math.max(Object.keys(domain.properties).length - 1, 0);
    for (const [name, child] of Object.entries(domain.properties)) {
      const part = largestEncoding(child);
      if (part === null) return null;
      size += lengthIn('bytes', jcs(name)) + 1 + part;
    }
  }
  return size === null ? null : domain.nullable ? Math.max(size, 4) : size;
}

/** @param {any} spec @param {any} definition */
function checkTarget(spec, definition) {
  const names = spec.path.split('.');
  const field = definition.fields[names[1]];
  if (!field) fail(6, spec.path, 'the spec names no registry field');
  let domain = field.domain;
  for (const name of names.slice(2)) {
    while (domain?.type === 'array') domain = domain.items;
    domain = domain?.properties?.[name];
    if (!domain) fail(6, spec.path, 'the spec names no registry path');
  }
  let item = domain;
  while (item?.type === 'array') item = item.items;
  const top = names.length === 2;
  const bounds = top && domain?.type !== 'array' && (field.min !== undefined || field.max !== undefined) ? field : item;
  const allowed = top && field.rank ? Object.keys(field.rank) : item?.enum;
  if (['text', 'choice'].includes(spec.kind) && !(top && field.kind === 'text') && !allowed && item?.type !== 'string') fail(6, spec.path, 'a string spec on a value that is no string');
  if (spec.kind === 'text') {
    if (allowed) fail(6, spec.path, 'an enum requires a choice spec');
    if (bounds?.max !== undefined && (spec.unit === 'chars' && bounds.unit === 'bytes' ? 4 * spec.max : spec.max) > bounds.max) fail(6, spec.path, 'admits text beyond registry bounds');
    if (bounds?.min !== undefined && spec.min < (spec.unit === 'bytes' && bounds.unit === 'chars' ? 4 * bounds.min - 3 : bounds.min)) fail(6, spec.path, 'admits text below registry bounds');
  } else if (spec.kind === 'choice') {
    for (const value of spec.values) {
      if (value.includes('\u0000') || (allowed && !allowed.includes(value)) || (item && checkDomain(item, value) !== null)
        || (bounds?.max !== undefined && lengthIn(bounds.unit, value) > bounds.max) || (bounds?.min !== undefined && lengthIn(bounds.unit, value) < bounds.min)) fail(6, spec.path, 'admits a choice the registry refuses');
    }
  } else if (spec.kind === 'number') {
    if (item?.type !== 'number') fail(6, spec.path, 'a number spec on a value that is no number');
    if (item.min !== undefined && spec.min < item.min) fail(6, spec.path, 'admits a value below the registry minimum');
    if (item.max !== undefined && spec.max > item.max) fail(6, spec.path, 'admits a value above the registry maximum');
    if (item.integer && !spec.integer && (spec.quantum == null || !Number.isInteger(spec.quantum))) fail(6, spec.path, 'admits a fraction the registry refuses');
    if (item.quantum !== undefined && (spec.quantum == null || !isOnQuantum(spec.quantum, item.quantum))) fail(6, spec.path, 'admits a value off the registry quantum');
  } else if (spec.kind === 'count') {
    if (domain?.type !== 'array') fail(6, spec.path, 'a count spec on a value that is no array');
    if (domain.maxItems !== undefined && spec.max > domain.maxItems) fail(6, spec.path, 'admits too many items');
    const itemSize = largestEncoding(domain.items);
    if (itemSize !== null && field.max !== undefined && 2 + spec.max * itemSize + Math.max(spec.max - 1, 0) > field.max) fail(6, spec.path, 'items encode beyond the field bound');
  } else fail(6, spec.path, 'unknown spec kind');
}

export const RegistryCheck = Object.freeze({
  /** @param {EntityType} type @param {import('../../../src/platform/domain-kit/entities.js').Writable<any> | null} sample @param {RuleBook} book */
  entity(type, sample, book) {
    const definition = /** @type {any} */ (book.registry.type(type.type));
    if (!definition || definition.scope !== book.registry.scopeKindOf(type.scope) || !definition.scope.startsWith('product:')) fail(1, type.type, 'the registry declares no type in this product scope');
    if (type.isRemovable && !definition.life) fail(2, type.type, 'a removable type without life');
    if (type.orderField !== null) {
      const order = definition.fields[type.orderField];
      if (order?.writer !== 'client' || order.kind !== 'lww' || order.domain?.type !== 'fracKey') fail(3, type.type, 'the order field is no client lww fracKey');
    }
    if (sample === null) return;
    const written = sample.fields();
    for (const name of Object.keys(written).sort()) {
      const field = definition.fields[name];
      if (field?.writer !== 'client' || field.kind === 'serial' || name === type.orderField) fail(4, `${type.type}.${name}`, 'the sample writes no client field');
    }
    for (const check of type.checks ?? []) if (check.field !== null && !(check.field in written)) fail(5, `${type.type}.${check.field}`, 'a check on a field the entity does not write');
    const specs = /** @type {any[]} */ (book.rules.flatMap((rule) => rule.spec === null ? [] : [rule.spec]));
    for (const spec of specs.filter((spec) => spec.path.startsWith(`${type.type}.`))) {
      if (!type.checks?.some((check) => check.field === spec.path.split('.')[1])) fail(6, spec.path, 'a LOCAL spec on a field with no check');
      checkTarget(spec, definition);
    }
    if (type.isDraftable) {
      if (jcs(type.decode(Fields.values(type.type, sample.id.record, written)).fields()) !== jcs(written)) fail(7, type.type, 'the sample does not round trip');
      if (type.savesGuarded && definition.textFieldNames.length > 0) fail(8, type.type, 'a guarded type has a text field');
    }
    for (const [name, field] of Object.entries(/** @type {Record<string, any>} */ (definition.fields))) {
      for (const leaf of leaves(field.domain, `${type.type}.${name}`)) {
        if (leaf.domain.quantum !== undefined && !specs.some((spec) => spec.path === leaf.path && spec.kind === 'number' && spec.quantum != null && isOnQuantum(spec.quantum, leaf.domain.quantum))) fail(9, leaf.path, 'a quantum has no number spec');
      }
    }
    for (const name of Object.keys(written)) {
      const field = definition.fields[name];
      const strings = field.kind === 'text' ? [{ path: `${type.type}.${name}` }] : leaves(field.domain, `${type.type}.${name}`).filter((leaf) => leaf.domain.type === 'string');
      for (const { path } of strings) if (!specs.some((spec) => spec.path === path && ['text', 'choice'].includes(spec.kind))) fail(10, path, 'a string has no text or choice spec');
    }
    if (definition.wholePut) {
      for (const name of definition.clientLatticeFieldNames) if (!(name in written)) fail(11, `${type.type}.${name}`, 'a whole type omits a client field');
      if (type.savesGuarded) fail(11, type.type, 'a whole type has guarded saves');
    }
    if (type.timestampField !== null) {
      const name = type.timestampField;
      const field = definition.fields[name];
      if (!definition.wholePut || field?.writer !== 'client' || field.kind !== 'lww' || field.domain?.type !== 'number' || !field.domain.integer || !(name in written)) fail(11, `${type.type}.${name}`, 'the timestamp is no whole client lww integer field');
      if (type.checks?.some((check) => check.field === name)) fail(11, `${type.type}.${name}`, 'a check reaches the timestamp');
    }
  },
});

export const RuleBookParity = Object.freeze({
  /** @param {RuleBook} book @param {string} file */
  check(book, file) { assert.equal(jcs(book.json), jcs(Contract.json(file)), `${file}: actual book ${jcs(book.json)}`); },
});

/** @param {any} json @param {string} name @returns {boolean} */
function hasViolation(json, name) {
  if (json === null || typeof json !== 'object') return false;
  if (json.rule === name && typeof json.path === 'string' && typeof json.reason === 'string') return true;
  return Object.values(json).some((value) => hasViolation(value, name));
}

export const RuleBookCheck = Object.freeze({
  /** @template R @param {RuleBook} book @param {import('../../../src/platform/domain-kit/refusals.js').Refusals<R>} refusals @param {string} valuesFile @param {string[]} [actionFiles] */
  check(book, refusals, valuesFile, actionFiles = []) {
    const values = Contract.vectors(valuesFile);
    const actions = actionFiles.flatMap((file) => Contract.vectors(file));
    const seen = new Set();
    for (const rule of book.rules) {
      /** @param {string} reason @returns {never} */
      const failure = (reason) => { throw new CheckFailure('RuleBookCheck', 0, rule.name, reason); };
      if (seen.has(rule.name)) failure('two rules share the name');
      seen.add(rule.name);
      if (rule.kind === 'local') {
        if (rule.spec !== null && !values.some((vector) => vector.input.spec?.path === rule.name)) failure('a LOCAL spec has no spec vector');
        if (rule.spec === null && ![...values, ...actions].some((vector) => hasViolation(vector.expect, rule.name))) failure('a LOCAL rule has no violation vector');
        if (rule.spec !== null && book.entities.some((entity) => rule.name.startsWith(`${entity.type}.`))
          && !values.some((vector) => vector.input.entity && hasViolation(vector.expect, rule.name))) failure('a field spec has no entity violation vector');
      }
      const paths = /** @type {const} */ (['predicted', 'notice']);
      for (const code of rule.codes) for (const path of rule.kind === 'serverDecided' ? paths : [paths[1]]) {
        const detail = code === 'cap' ? { type: rule.subject, cap: /** @type {any} */ (book.registry.type(rule.subject))?.cap ?? 0 } : null;
        if (refusals.isGeneric(refusals.ofRefused(new Refused(code, { t: rule.subject, id: 'subject' }, detail, path)))) failure(`${code} on ${path} maps to a generic refusal`);
      }
    }
  },
});
