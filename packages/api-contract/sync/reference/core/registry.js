// §2.4 the registry: types, fields and commands, in registry.schema.json's format.
// Scope references (§9.1 ScopeRef) map to registry scope kinds here.

import { References } from './references.js';
import { checkFieldValue, checkScalarId } from './values.js';

const LATTICE_KINDS = new Set(['lww', 'ranked', 'fww', 'const', 'time']);
const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|/';
const DASH = Symbol('dash');
const MAX_REPEAT = 65_535;
// §9.6's refusal codes, which no product's `codes` may declare again.
const ENGINE_CODES = new Set(['not-found', 'scope-dead', 'forbidden', 'invalid', 'too-large', 'clock-skew', 'id-taken', 'id-spent',
  'unknown-record', 'record-dead', 'parent-dead', 'stale', 'cap', 'base-unknown', 'request-conflict', 'request-running',
  'internal', 'target-merged']);

export class RegistryError extends Error {}

// A bracket class of literal characters and ranges from `start`, just past its `[`: the index of its
// `]`, or -1. A `-` is literal first or last, and otherwise joins two characters into a range. A class
// beginning with `^` or `:`, or holding `--`, reads differently across dialects.
function classEnd(body, start) {
  if (body[start] === '^' || body[start] === ':') return -1;
  const items = [];
  let i = start;
  while (i < body.length && body[i] !== ']') {
    if (body[i] === '\\') {
      const escaped = body[i + 1] ?? '';
      if (escaped === '' || !`${SYNTAX_CHARACTERS}-`.includes(escaped)) return -1;
      items.push(escaped);
      i += 2;
    } else if ('[&~'.includes(body[i])) {
      return -1;
    } else {
      items.push(body[i] === '-' ? DASH : body[i]);
      i += 1;
    }
  }
  if (i === body.length || items.length === 0 || body.slice(start, i).includes('--')) return -1;
  for (let k = 1; k < items.length - 1; k += 1) {
    if (items[k] !== DASH) continue;
    const [low, high] = [items[k - 1], items[k + 1]];
    if (low === DASH || high === DASH || low > high) return -1;
    if (items[k + 2] === DASH && k + 2 !== items.length - 1) return -1;
  }
  return i;
}

// §2.4 patterns: printable ASCII; `^` and `$` around literal characters, escaped syntax characters,
// bracket classes, groups (alternation only inside one) and greedy quantifiers counting at most
// MAX_REPEAT.
export function isPortablePattern(source) {
  if (typeof source !== 'string' || !/^[ -~]*$/.test(source) || source.length < 2) return false;
  if (source[0] !== '^' || source[source.length - 1] !== '$') return false;
  const body = source.slice(1, -1);
  let depth = 0;
  let quantifiable = false;
  let i = 0;
  while (i < body.length) {
    const char = body[i];
    if (char === '\\') {
      const escaped = body[i + 1] ?? '';
      if (escaped === '' || !SYNTAX_CHARACTERS.includes(escaped)) return false;
      i += 2;
      quantifiable = true;
    } else if (char === '[') {
      const end = classEnd(body, i + 1);
      if (end === -1) return false;
      i = end + 1;
      quantifiable = true;
    } else if (char === '(') {
      if (body[i + 1] === '?' && body[i + 2] !== ':') return false;
      i += body[i + 1] === '?' ? 3 : 1;
      depth += 1;
      quantifiable = false;
    } else if (char === ')') {
      if (depth === 0) return false;
      depth -= 1;
      i += 1;
      quantifiable = true;
    } else if (char === '|') {
      if (depth === 0) return false;
      i += 1;
      quantifiable = false;
    } else if ('?*+{'.includes(char)) {
      const counted = /^\{(\d+)(?:,(\d*))?\}/.exec(body.slice(i));
      if (!quantifiable || (char === '{' && !counted)) return false;
      const [low, high] = counted ? [Number(counted[1]), counted[2] ? Number(counted[2]) : undefined] : [];
      if (low > MAX_REPEAT || high > MAX_REPEAT || high < low) return false;
      i += counted ? counted[0].length : 1;
      quantifiable = false;
    } else if ('^$.]}'.includes(char)) {
      return false;
    } else {
      i += 1;
      quantifiable = true;
    }
  }
  return depth === 0;
}

// §2.4: whether a keyed type's key leads back to it, through the keys of the types it names in turn.
function keyReachesItself(registry, start) {
  const refsOf = (type) => [type.key?.ref, ...(type.key?.tuple ?? []).map((part) => part.ref)].filter(Boolean);
  const seen = new Set();
  const pending = refsOf(start);
  while (pending.length) {
    const name = pending.pop();
    if (name === start.type) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const type = registry.type(name);
    if (type) pending.push(...refsOf(type));
  }
  return false;
}

// A domain's first fault against §2.4, or null, at any depth: a number domain's quantum is an integer or
// 1/k, and a string domain's pattern is portable and its bounds state their unit.
function domainFault(domain) {
  switch (domain.type) {
    case 'number':
      if (domain.quantum !== undefined && !Number.isInteger(domain.quantum) && !Number.isInteger(1 / domain.quantum)) return `the quantum ${domain.quantum} is neither an integer nor 1/k`;
      return null;
    case 'string':
      if (domain.pattern !== undefined && !isPortablePattern(domain.pattern)) return `the pattern ${domain.pattern} is outside §2.4's patterns`;
      if ((domain.min !== undefined || domain.max !== undefined) && domain.unit === undefined) return 'a string bound states its unit';
      return null;
    case 'array':
      return domainFault(domain.items);
    case 'object':
      return Object.values(domain.properties).map(domainFault).find((fault) => fault !== null) ?? null;
    default:
      return null;
  }
}

export class TypeDef {
  constructor(json) {
    Object.assign(this, json);
    this.fields = json.fields ?? {};
  }

  get hasBorn() {
    return this.identity === 'minted' || this.identity === 'derived';
  }

  field(name) {
    return Object.hasOwn(this.fields, name) ? this.fields[name] : undefined;
  }

  fieldNames(predicate) {
    return Object.keys(this.fields).filter((name) => predicate(this.fields[name]));
  }

  get latticeFieldNames() {
    return this.fieldNames((field) => LATTICE_KINDS.has(field.kind));
  }

  // The fields a whole put writes (§7.1 step 4): every lattice field a client writes.
  get clientLatticeFieldNames() {
    return this.fieldNames((field) => LATTICE_KINDS.has(field.kind) && field.writer === 'client');
  }

  get textFieldNames() {
    return this.fieldNames((field) => field.kind === 'text');
  }

  get serialFieldNames() {
    return this.fieldNames((field) => field.kind === 'serial');
  }

  get parentField() {
    return this.fieldNames((field) => field.parent === true)[0];
  }
}

export class Registry {
  constructor(json) {
    this.name = json.registry;
    this.version = json.version;
    this.minVersion = json.minVersion;
    this.products = json.products;
    this.types = new Map(json.types.map((type) => [type.type, new TypeDef(type)]));
    this.commands = new Map(json.commands.map((command) => [command.name, command]));
    this.validate();
  }

  static isLattice(kind) {
    return LATTICE_KINDS.has(kind);
  }

  type(name) {
    return this.types.get(name);
  }

  command(name) {
    return this.commands.get(name);
  }

  get governingType() {
    return [...this.types.values()].find((type) => type.governs === 'tree');
  }

  // `self/<product>`, `self/overlay/<T>`, `tree/<T>`, `device/<product>` → a registry scope kind.
  scopeKindOf(ref) {
    if (typeof ref !== 'string') return null;
    const parts = ref.split('/');
    if (parts.length === 2 && parts[0] === 'self' && Object.hasOwn(this.products, parts[1])) return `product:${parts[1]}`;
    if (parts.length === 3 && parts[0] === 'self' && parts[1] === 'overlay' && parts[2] !== '') return 'overlay';
    if (parts.length === 2 && parts[0] === 'tree' && parts[1] !== '') return 'tree';
    if (parts.length === 2 && parts[0] === 'device' && Object.hasOwn(this.products, parts[1])) return 'device';
    return null;
  }

  productOfScopeKind(kind) {
    if (kind.startsWith('product:')) return kind.slice('product:'.length);
    const governing = this.governingType;
    return governing ? governing.scope.slice('product:'.length) : null;
  }

  productOfRef(ref) {
    const kind = this.scopeKindOf(ref);
    if (kind === 'device') return ref.split('/')[1];
    return kind ? this.productOfScopeKind(kind) : null;
  }

  typesIn(scopeKind) {
    return [...this.types.values()].filter((type) => type.scope === scopeKind);
  }

  // D-4: the field whose values open a tree to every reader, with those values.
  get opening() {
    for (const type of this.types.values()) {
      if (type.scope !== 'tree' || type.identity !== 'singleton') continue;
      for (const [name, field] of Object.entries(type.fields)) if (field.opens) return { type: type.type, id: type.singletonId, field: name, values: field.opens };
    }
    return null;
  }

  // §6.7: the server-internal commands that run before every pull of a scope of this kind.
  beforePullCommands(scopeKind) {
    return [...this.commands.values()].filter((command) => command.beforePull === true && command.scope === scopeKind);
  }

  primaryTypes(product) {
    return [...this.types.values()].filter((type) => type.primary === true && type.scope === `product:${product}`);
  }

  // §9.2: the type a product's holdings tally, or null when it declares none.
  headlineType(product) {
    return [...this.types.values()].find((type) => type.headline === true && type.scope === `product:${product}`) ?? null;
  }

  validate() {
    const fail = (message) => {
      throw new RegistryError(`${this.name}: ${message}`);
    };
    for (const type of this.types.values()) {
      const definitions = ['idPattern', 'idDomain', 'key'].filter((name) => Object.hasOwn(type, name));
      if (definitions.length !== 1) fail(`${type.type}: exactly one idPattern, idDomain or key defines ids`);
      if (type.key && type.identity !== 'keyed') fail(`${type.type}: only a keyed type declares key`);
      if (type.singletonId !== undefined && type.identity !== 'singleton') fail(`${type.type}: only a singleton declares singletonId`);
      if (type.idDomain !== undefined) {
        const domain = type.idDomain;
        if (!domain || typeof domain !== 'object' || Array.isArray(domain)
          || Object.keys(domain).some((name) => !['type', 'unit', 'min', 'max'].includes(name))
          || domain.type !== 'string' || domain.unit !== 'chars' || domain.min !== 1
          || !Number.isSafeInteger(domain.max) || domain.max < 1) fail(`${type.type}: idDomain is a nonempty bounded string in chars`);
        if (!['derived', 'keyed'].includes(type.identity) || (type.identity === 'derived' && type.idSpace !== 'scope')
          || (type.idSpace !== undefined && type.idSpace !== 'scope')) fail(`${type.type}: idDomain is for scope-local derived or keyed ids`);
        if (type.identity === 'derived' && (!type.derive || checkScalarId(type, type.derive.fallback))) fail(`${type.type}: derive fallback is outside idDomain`);
      }
      if (type.identity === 'singleton' && type.life) fail(`${type.type}: a singleton has no life`);
      if (type.hasBorn && !type.life) fail(`${type.type}: minted and derived types have life`);
      if (type.governs && !type.scope.startsWith('product:')) fail(`${type.type}: a governing type lives in a product scope`);
      if (type.revivable && !type.hasBorn) fail(`${type.type}: only a minted or derived type is revivable`);
      if (type.revivable && type.deadRows !== 'keep') fail(`${type.type}: a revivable type keeps its dead rows`);
      if (type.governs && (type.identity !== 'minted' || type.revivable)) fail(`${type.type}: a governing type is minted and not revivable`);
      if (type.governs && type.idSpace !== 'global') fail(`${type.type}: a governing type's ids are global`);
      if (type.hasBorn && !type.mint) fail(`${type.type}: minted and derived types declare mint`);
      if (type.mint) {
        const { prefix, alphabet, length } = type.mint;
        if (type.idDomain) {
          if (typeof prefix !== 'string' || typeof alphabet !== 'string'
            || [prefix, alphabet].some((text) => text.includes('\0') || /[\uD800-\uDFFF]/u.test(text))
            || [...alphabet].length < 2 || !Number.isSafeInteger(length) || length < 1
            || length > type.idDomain.max - [...prefix].length) fail(`${type.type}: mint is outside idDomain`);
        } else {
          if ([...alphabet].some((char) => checkScalarId(type, prefix + char.repeat(length)))) fail(`${type.type}: a minted id does not match idPattern`);
        }
      }
      if (type.idPattern !== undefined && !isPortablePattern(type.idPattern)) fail(`${type.type}: idPattern ${type.idPattern} is outside §2.4's patterns`);
      if (!type.origins.includes('replica')) fail(`${type.type}: origins always include replica`);
      if (type.primary !== undefined && type.primary !== true) fail(`${type.type}: primary is true or absent`);
      if (type.headline !== undefined && type.headline !== true) fail(`${type.type}: headline is true or absent`);
      if (type.headline && (!type.primary || !type.scope.startsWith('product:'))) fail(`${type.type}: a headline type is a primary type of a product scope`);
      if (type.headline && this.typesIn(type.scope).some((other) => other !== type && other.headline)) fail(`${type.type}: a product has at most one headline type`);
      if (type.visibleWhen && type.life) fail(`${type.type}: visibleWhen is for types without life`);
      if (type.wholePut && (type.identity !== 'keyed' || !type.life)) fail(`${type.type}: wholePut is for keyed types with life`);
      if (type.wholePut && type.textFieldNames.length) fail(`${type.type}: a wholePut type has no text field`);
      if (type.wholePut && type.clientLatticeFieldNames.some((name) => type.field(name).kind !== 'lww')) fail(`${type.type}: a wholePut type's client fields are lww`);
      for (const part of type.key?.tuple ?? []) if (!this.types.has(part.ref)) fail(`${type.type}: key refers to unknown ${part.ref}`);
      if (type.key?.ref && !this.types.has(type.key.ref)) fail(`${type.type}: key refers to unknown ${type.key.ref}`);
      if (keyReachesItself(this, type)) fail(`${type.type}: its key leads back to its own type`);
      if (type.fieldNames((field) => field.parent === true).length > 1) fail(`${type.type}: at most one parent field`);
      for (const name of type.visibleWhen ?? []) if (!type.field(name)) fail(`${type.type}: visibleWhen names unknown ${name}`);
      for (const [name, field] of Object.entries(type.fields)) {
        if (field.ref && !this.types.has(field.ref)) fail(`${type.type}.${name}: ref to unknown ${field.ref}`);
        if (field.domain?.type === 'fracKey' && !type.hasBorn) fail(`${type.type}.${name}: an order field belongs to a minted or derived type`);
        for (const next of field.serialNext ?? []) if (!type.field(next)) fail(`${type.type}.${name}: serialNext names unknown ${next}`);
        if ((field.min !== undefined || field.max !== undefined) && field.unit === undefined) fail(`${type.type}.${name}: a bound states its unit`);
        const fault = field.domain ? domainFault(field.domain) : null;
        if (fault) fail(`${type.type}.${name}: ${fault}`);
        if (Object.hasOwn(field, 'default') && !LATTICE_KINDS.has(field.kind)) fail(`${type.type}.${name}: a default is for a lattice field`);
        if (field.opens) {
          const placed = type.scope === 'tree' && type.identity === 'singleton' && field.writer === 'server';
          if (!placed) fail(`${type.type}.${name}: opens is for a server-written field of a tree singleton`);
          if (field.domain?.enum && field.opens.some((value) => !field.domain.enum.includes(value))) fail(`${type.type}.${name}: opens values outside the domain`);
        }
      }
    }
    for (const command of this.commands.values()) {
      if (command.scopedEffects !== undefined && command.scopedEffects !== true) fail(`${command.name}: scopedEffects is true or absent`);
      if (command.engine !== undefined && (!['capture', 'restore'].includes(command.engine) || !command.scopedEffects || Object.keys(command.args).length)) fail(`${command.name}: an engine command requires scopedEffects and empty args`);
      if (command.engine === 'restore') {
        if (!command.predicts?.length) fail(`${command.name}: a restore command predicts the types it restores`);
        for (const t of command.predicts ?? []) {
          const type = this.types.get(t);
          if (type && (type.scope !== command.scope || type.governs)) fail(`${command.name}: a restore restores types of its scope that govern no tree`);
        }
        if (command.refPaths !== undefined) fail(`${command.name}: a restore's arguments are fixed`);
      }
      if (command.inverse !== undefined) {
        const input = command.args.input;
        if (command.inverse !== true || !command.scopedEffects || command.engine !== undefined) fail(`${command.name}: an inverse command is a product command with scopedEffects`);
        if (Object.keys(command.args).join() !== 'input' || input.type !== 'json' || input.optional) fail(`${command.name}: an inverse command declares only its required json input`);
      }
      for (const t of command.predicts ?? []) if (!this.types.has(t)) fail(`${command.name}: predicts unknown ${t}`);
      if (command.serverInternal && command.origins.includes('replica')) fail(`${command.name}: server-internal commands have server origin only`);
      if (command.beforePull && !command.serverInternal) fail(`${command.name}: a beforePull command is server-internal`);
      for (const t of command.predicts ?? []) if (this.types.get(t)?.wholePut) fail(`${command.name}: no command writes the wholePut type ${t}`);
      for (const [name, arg] of Object.entries(command.args)) {
        const ref = /^ref<(.+)>$/.exec(arg.type)?.[1];
        if (ref && !this.types.has(ref)) fail(`${command.name}.${name}: ref to unknown ${ref}`);
        const fault = arg.domain ? domainFault(arg.domain) : null;
        if (fault) fail(`${command.name}.${name}: ${fault}`);
      }
    }
    this.references = new References(this, fail);
    for (const type of this.types.values()) {
      for (const [name, field] of Object.entries(type.fields)) {
        if (!Object.hasOwn(field, 'default')) continue;
        const reason = checkFieldValue(this, field, field.default);
        if (reason) fail(`${type.type}.${name}: the default is off the field's domain: ${reason}`);
      }
    }
    const declared = new Set();
    for (const [product, def] of Object.entries(this.products)) {
      for (const [name, row] of Object.entries(def.device ?? {})) {
        if (!isPortablePattern(row.keyPattern)) fail(`${product} device row ${name}: keyPattern ${row.keyPattern} is outside §2.4's patterns`);
      }
      for (const code of def.codes ?? []) {
        if (ENGINE_CODES.has(code)) fail(`${product}: ${code} is an engine code`);
        if (declared.has(code)) fail(`${product}: ${code} is declared twice`);
        declared.add(code);
      }
    }
  }
}
