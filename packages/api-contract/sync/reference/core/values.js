// Field values against the registry (§2.4, §6.1 step 2): ids, domains, bounds in their unit, and quanta,
// with the client's rounding to a quantum (§7.1 step 4).

import { MS_LIMIT } from './constants.js';
import { isOrderKey } from './fracindex.js';
import { jcs } from './jcs.js';
import { Stamp } from './stamp.js';

// A bound's unit, which the registry always states (D-9): code points or UTF-8 bytes.
export function lengthIn(unit, text) {
  if (unit === 'chars') return [...text].length;
  if (unit === 'bytes') return Buffer.byteLength(text, 'utf8');
  throw new Error(`a bound without a unit: ${unit}`);
}

export function roundHalfAway(y) {
  const rounded = Math.sign(y) * Math.round(Math.abs(y));
  return rounded === 0 ? 0 : rounded;
}

export function roundToQuantum(value, quantum) {
  if (Number.isInteger(quantum)) return roundHalfAway(value / quantum) * quantum;
  const steps = Math.round(1 / quantum);
  return roundHalfAway(value * steps) / steps;
}

export function isOnQuantum(value, quantum) {
  return roundToQuantum(value, quantum) === value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEpochMs(value) {
  return Number.isInteger(value) && value >= 0 && value < MS_LIMIT;
}

function checkBounds(bounds, value) {
  if (bounds.max === undefined && bounds.min === undefined) return null;
  const measured = typeof value === 'string' ? value : jcs(value);
  const length = lengthIn(bounds.unit, measured);
  if (bounds.min !== undefined && length < bounds.min) return `shorter than ${bounds.min} ${bounds.unit}`;
  if (bounds.max !== undefined && length > bounds.max) return `longer than ${bounds.max} ${bounds.unit}`;
  return null;
}

export function checkDomain(domain, value) {
  if (value === null) return domain.nullable ? null : 'null is outside the domain';
  switch (domain.type) {
    case 'string':
      if (typeof value !== 'string') return 'not a string';
      if (domain.enum && !domain.enum.includes(value)) return `not one of ${domain.enum.join(', ')}`;
      if (domain.pattern && !new RegExp(domain.pattern, 'u').test(value)) return 'does not match the pattern';
      return checkBounds(domain, value);
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'not a number';
      if (domain.integer && !Number.isSafeInteger(value)) return 'not a safe integer';
      if (domain.min !== undefined && value < domain.min) return `below ${domain.min}`;
      if (domain.max !== undefined && value > domain.max) return `above ${domain.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'not a boolean';
    case 'fracKey':
      return isOrderKey(value) ? null : 'not an order key';
    case 'stamp':
      return Stamp.isValid(value) ? null : 'not a stamp';
    case 'id':
      return typeof value === 'string' ? null : 'not an id';
    case 'json':
      return null;
    case 'array':
      if (!Array.isArray(value)) return 'not an array';
      if (domain.maxItems !== undefined && value.length > domain.maxItems) return `more than ${domain.maxItems} items`;
      for (const item of value) {
        const reason = checkDomain(domain.items, item);
        if (reason) return `item ${reason}`;
      }
      return null;
    case 'object':
      if (!isPlainObject(value)) return 'not an object';
      for (const key of Object.keys(value)) if (!Object.hasOwn(domain.properties, key)) return `unknown property ${key}`;
      for (const key of domain.required ?? []) if (!Object.hasOwn(value, key)) return `missing property ${key}`;
      for (const [key, inner] of Object.entries(value)) {
        const reason = checkDomain(domain.properties[key], inner);
        if (reason) return `${key} ${reason}`;
      }
      return null;
    default:
      return `unknown domain ${domain.type}`;
  }
}

export function checkId(registry, type, id) {
  if (type.identity === 'singleton') return id === type.singletonId ? null : `not the singleton id ${type.singletonId}`;
  if (type.key?.tuple) {
    if (!Array.isArray(id) || id.length !== type.key.tuple.length) return `not a ${type.key.tuple.length}-part key`;
    for (const [index, part] of type.key.tuple.entries()) {
      const reason = checkId(registry, registry.type(part.ref), id[index]);
      if (reason) return `${part.name}: ${reason}`;
    }
    return null;
  }
  if (type.key?.ref) return checkId(registry, registry.type(type.key.ref), id);
  if (typeof id !== 'string') return 'not a string id';
  return new RegExp(type.idPattern, 'u').test(id) ? null : `does not match ${type.idPattern}`;
}

export function checkFieldValue(registry, field, value) {
  switch (field.kind) {
    case 'ranked':
      return typeof value === 'string' && Object.hasOwn(field.rank, value) ? null : 'not a ranked value';
    case 'time':
      return isEpochMs(value) ? null : 'not an epoch ms';
    case 'serial':
      return Number.isSafeInteger(value) && value >= 1 ? null : 'not a positive safe integer';
    case 'text':
      return typeof value === 'string' ? null : 'not a string';
    default:
      break;
  }
  if (field.ref && value !== null) {
    const reason = checkId(registry, registry.type(field.ref), value);
    if (reason) return `ref<${field.ref}> ${reason}`;
  } else if (field.ref && !field.domain?.nullable) {
    return 'null is outside the domain';
  }
  if (field.domain) {
    const reason = checkDomain(field.domain, value);
    if (reason) return reason;
  }
  if (value !== null) {
    const reason = checkBounds(field, value);
    if (reason) return reason;
  }
  if (field.quantum !== undefined && typeof value === 'number' && !isOnQuantum(value, field.quantum)) {
    return `off the quantum ${field.quantum}`;
  }
  return null;
}

export function checkArgument(registry, arg, value) {
  if (arg.type === 'time' || arg.type === 'instant') return isEpochMs(value) ? null : 'not an epoch ms';
  const ref = /^ref<(.+)>$/.exec(arg.type)?.[1];
  if (ref) return checkId(registry, registry.type(ref), value);
  return arg.domain ? checkDomain(arg.domain, value) : null;
}
