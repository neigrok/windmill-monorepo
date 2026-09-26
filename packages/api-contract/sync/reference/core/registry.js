// §2.4 the registry: types, fields and commands, read from a file in registry.schema.json's format.
// Scope references (§9.1 ScopeRef) map to registry scope kinds here.

import { readFileSync } from 'node:fs';

const LATTICE_KINDS = new Set(['lww', 'ranked', 'fww', 'const', 'time']);

export class RegistryError extends Error {}

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

  get textFieldNames() {
    return this.fieldNames((field) => field.kind === 'text');
  }

  get serialFieldNames() {
    return this.fieldNames((field) => field.kind === 'serial');
  }

  get parentField() {
    return this.fieldNames((field) => field.parent === true)[0];
  }

  // Every id this record names: ref fields' values, and the parts of a ref-built key (§7.7 step 3).
  referencesOf(id, fieldValues) {
    const found = [];
    if (this.key?.ref) found.push({ via: 'key', name: null, t: this.key.ref, id });
    if (this.key?.tuple) {
      this.key.tuple.forEach((part, index) => found.push({ via: 'key', name: part.name, t: part.ref, id: id[index] }));
    }
    for (const [name, def] of Object.entries(this.fields)) {
      const value = fieldValues[name];
      if (def.ref && typeof value === 'string') found.push({ via: 'field', name, t: def.ref, id: value });
    }
    return found;
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

  static fromFile(path) {
    return new Registry(JSON.parse(readFileSync(path, 'utf8')));
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

  validate() {
    const fail = (message) => {
      throw new RegistryError(`${this.name}: ${message}`);
    };
    for (const type of this.types.values()) {
      if (type.identity === 'singleton' && type.life) fail(`${type.type}: a singleton has no life`);
      if (type.hasBorn && !type.life) fail(`${type.type}: minted and derived types have life`);
      if (type.governs && !type.scope.startsWith('product:')) fail(`${type.type}: a governing type lives in a product scope`);
      if (type.revivable && type.deadRows !== 'keep') fail(`${type.type}: a revivable type keeps its dead rows`);
      if (type.governs && (type.identity !== 'minted' || type.revivable)) fail(`${type.type}: a governing type is minted and not revivable`);
      if (type.hasBorn && !type.mint) fail(`${type.type}: minted and derived types declare mint`);
      if (type.mint) {
        const pattern = new RegExp(type.idPattern, 'u');
        const sample = (char) => type.mint.prefix + char.repeat(type.mint.length);
        if ([...type.mint.alphabet].some((char) => !pattern.test(sample(char)))) fail(`${type.type}: a minted id does not match idPattern`);
      }
      if (!type.origins.includes('replica')) fail(`${type.type}: origins always include replica`);
      if (type.visibleWhen && type.life) fail(`${type.type}: visibleWhen is for types without life`);
      for (const part of type.key?.tuple ?? []) if (!this.types.has(part.ref)) fail(`${type.type}: key refers to unknown ${part.ref}`);
      if (type.key?.ref && !this.types.has(type.key.ref)) fail(`${type.type}: key refers to unknown ${type.key.ref}`);
      if (type.fieldNames((field) => field.parent === true).length > 1) fail(`${type.type}: at most one parent field`);
      for (const name of type.visibleWhen ?? []) if (!type.field(name)) fail(`${type.type}: visibleWhen names unknown ${name}`);
      for (const [name, field] of Object.entries(type.fields)) {
        if (field.ref && !this.types.has(field.ref)) fail(`${type.type}.${name}: ref to unknown ${field.ref}`);
        for (const next of field.serialNext ?? []) if (!type.field(next)) fail(`${type.type}.${name}: serialNext names unknown ${next}`);
        if (field.quantum !== undefined && field.domain?.type !== 'number') fail(`${type.type}.${name}: quantum needs a number domain`);
        if (field.opens) {
          const placed = type.scope === 'tree' && type.identity === 'singleton' && field.writer === 'server';
          if (!placed) fail(`${type.type}.${name}: opens is for a server-written field of a tree singleton`);
          if (field.domain?.enum && field.opens.some((value) => !field.domain.enum.includes(value))) fail(`${type.type}.${name}: opens values outside the domain`);
        }
      }
    }
    for (const command of this.commands.values()) {
      if (command.serverInternal && command.origins.includes('replica')) fail(`${command.name}: server-internal commands have server origin only`);
      if (command.beforePull && !command.serverInternal) fail(`${command.name}: a beforePull command is server-internal`);
      for (const [name, arg] of Object.entries(command.args)) {
        const ref = /^ref<(.+)>$/.exec(arg.type)?.[1];
        if (ref && !this.types.has(ref)) fail(`${command.name}.${name}: ref to unknown ${ref}`);
      }
    }
  }
}
