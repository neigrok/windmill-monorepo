// E-8 typed references (engine.md §2.4 References): every place a registry declares a record identity
// inside a value, compiled once per registry into leaves. A record's own id, its key parts, a `ref` field,
// a `ref<t>` argument and each literal property path a `refPaths` entry names is a leaf; this one traversal
// serves admission's validation, dependency extraction (§7.7 step 3) and the global and scoped id maps.
// Unannotated JSON and text are never read.

import { jcs } from './jcs.js';
import { checkId } from './values.js';

const NAME = /^[a-z][A-Za-z0-9]*$/;
const PRODUCT_SCOPE = /^self\/([a-z][a-z0-9]*)$/;
const VALUE_KINDS = new Set(['lww', 'fww', 'const']);
const LEAF_DOMAINS = new Set(['string', 'id', 'json']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => a.length === b.length && a.every((part, index) => part === b[index]);
const isPrefix = (a, b) => a.length < b.length && a.every((part, index) => part === b[index]);

// One place an identity sits in a holder: a delta, a row, a guard or a command. `base` is the engine's
// own part of the pointer (`['id']`, `['id', i]`, `['f', field, 0]` or `['args']`) and `path` the
// registry's literal property path below it. `role` is `identity` for a record's own id, `creation` for a
// command's proposed identity, and `ordinary` for every reference.
export class Leaf {
  constructor({ name, base, path = [], t, scope = { kind: 'origin' }, nullable = false, role = 'ordinary', annotated = false }) {
    Object.assign(this, { name, base, path, t, scope, nullable, role, annotated });
  }

  // The leaf in a holder: `absent`, `outerNull` (null on the way, which names nothing), `null`, `value`,
  // or `malformed` (something other than an object where the path continues).
  find(holder) {
    let node = holder;
    let parent;
    let key;
    for (const step of this.base) {
      if (node === null || typeof node !== 'object' || !Object.hasOwn(node, step)) return { state: 'absent' };
      parent = node;
      key = step;
      node = node[step];
    }
    for (const step of this.path) {
      if (node === null) return { state: 'outerNull' };
      if (!isPlainObject(node)) return { state: 'malformed' };
      if (!Object.hasOwn(node, step)) return { state: 'absent' };
      parent = node;
      key = step;
      node = node[step];
    }
    return { state: node === null ? 'null' : 'value', value: node, parent, key };
  }
}

// A logical id map (§7.7 write map): a global mapping renames an id of a global type in every scope; a
// scoped mapping renames an id of a scope-local type in one scope, keyed by that scope as the map's own
// governor mappings leave it. Mappings are `{t, from, id, scope?}`.
export class RecordMap {
  constructor(registry, mappings) {
    this.registry = registry;
    this.global = new Map();
    this.scoped = new Map();
    this.governors = new Map();
    const governing = registry.governingType?.type;
    for (const { t, from, id } of mappings) {
      if (registry.type(t)?.idSpace !== 'global') continue;
      this.global.set(`${t}|${jcs(from)}`, id);
      if (t === governing) this.governors.set(from, id);
    }
    for (const { t, from, id, scope } of mappings) {
      if (registry.type(t)?.idSpace === 'global') continue;
      this.scoped.set(`${this.scope(scope)}|${t}|${jcs(from)}`, id);
    }
  }

  // A tree or overlay ScopeRef after the governor mappings; any other scope as it is.
  scope(ref) {
    const kind = this.registry.scopeKindOf(ref);
    if (kind !== 'tree' && kind !== 'overlay') return ref;
    const tree = ref.split('/').pop();
    return this.governors.has(tree) ? ref.slice(0, ref.length - tree.length) + this.governors.get(tree) : ref;
  }

  globalTarget(t, id) {
    return this.global.get(`${t}|${jcs(id)}`);
  }

  scopedTarget(scope, t, id) {
    return this.scoped.get(`${scope}|${t}|${jcs(id)}`);
  }
}

export class References {
  constructor(registry, fail) {
    this.registry = registry;
    this.records = new Map();
    this.commands = new Map();
    this.annotatedFields = new Map();
    for (const type of registry.types.values()) this.records.set(type.type, this.compileType(type, fail));
    for (const command of registry.commands.values()) this.commands.set(command.name, this.compileCommand(command, fail));
  }

  compileType(type, fail) {
    const leaves = [];
    if (type.identity !== 'singleton') leaves.push(new Leaf({ name: 'id', base: ['id'], t: type.type, role: 'identity' }));
    if (type.key?.ref) leaves.push(new Leaf({ name: 'key', base: ['id'], t: type.key.ref }));
    (type.key?.tuple ?? []).forEach((part, index) => leaves.push(new Leaf({ name: `key.${part.name}`, base: ['id', index], t: part.ref })));
    for (const [name, field] of Object.entries(type.fields)) {
      const where = `${type.type}.${name}`;
      const base = ['f', name, 0];
      if (field.ref) leaves.push(new Leaf({ name, base, t: field.ref, nullable: field.domain?.nullable === true }));
      if (field.refPaths === undefined) continue;
      if (field.ref) fail(`${where}: a field holds one scalar ref or refPaths, not both`);
      if (!VALUE_KINDS.has(field.kind)) fail(`${where}: refPaths are for an lww, fww or const field`);
      const annotated = this.compilePaths(where, field.refPaths, { base, scopeKind: type.scope, domainAt: (path) => domainAlong(field.domain, path), fail });
      if (annotated.some((leaf) => leaf.role !== 'ordinary')) fail(`${where}: only a command argument proposes a creation`);
      this.annotatedFields.set(field, { name, leaves: annotated });
      leaves.push(...annotated);
    }
    return leaves;
  }

  compileCommand(command, fail) {
    const leaves = [];
    for (const [name, arg] of Object.entries(command.args)) {
      const t = /^ref<(.+)>$/.exec(arg.type)?.[1];
      if (t) leaves.push(new Leaf({ name, base: ['args'], path: [name], t }));
    }
    if (command.refPaths === undefined) return leaves;
    const where = command.name;
    const domainAt = (path) => {
      const arg = Object.hasOwn(command.args, path[0]) ? command.args[path[0]] : undefined;
      if (!arg) fail(`${where}: refPaths name the undeclared argument ${path[0]}`);
      if (arg.type !== 'json') fail(`${where}: refPaths reach into a json argument, not ${arg.type} ${path[0]}`);
      return domainAlong(arg.domain, path.slice(1));
    };
    const annotated = this.compilePaths(where, command.refPaths, { base: ['args'], scopeKind: command.scope, domainAt, shorthands: leaves, fail });
    for (const leaf of annotated.filter((candidate) => candidate.role === 'creation')) {
      const type = this.registry.type(leaf.t);
      if (!type.hasBorn) fail(`${where}.${leaf.name}: a creation names a minted or derived type`);
      if (!(command.predicts ?? []).includes(leaf.t)) fail(`${where}.${leaf.name}: a creation names a type the command predicts`);
    }
    return [...leaves, ...annotated];
  }

  // §2.4's load rules for one declaration's refPaths: literal nonempty paths through the value's object
  // domain, a known target with string ids, a scope of the target's family, each treeFrom source an
  // ordinary leaf of the same declaration holding a governing id, and no leaf declared twice or inside
  // another.
  compilePaths(where, refPaths, { base, scopeKind, domainAt, shorthands = [], fail }) {
    if (!Array.isArray(refPaths) || refPaths.length === 0) fail(`${where}: refPaths is a nonempty array`);
    const leaves = refPaths.map((declared) => {
      if (!isPlainObject(declared) || Object.keys(declared).some((key) => !['path', 'type', 'scope', 'nullable', 'role'].includes(key))) {
        fail(`${where}: a refPath holds path, type, scope, nullable and role only`);
      }
      const { path, type: t, scope, nullable, role } = declared;
      if (!isPath(path)) fail(`${where}: a refPath's path is a nonempty array of property names`);
      const name = path.join('.');
      const target = this.registry.type(t);
      if (!target) fail(`${where}.${name}: refers to unknown ${t}`);
      if (target.key?.tuple) fail(`${where}.${name}: a typed leaf holds a string id, never ${t}'s tuple`);
      if (nullable !== undefined && nullable !== true) fail(`${where}.${name}: nullable is true or absent`);
      if (role !== undefined && role !== 'creation') fail(`${where}.${name}: role is creation or absent`);
      const domain = domainAt(path);
      if (domain !== undefined && !LEAF_DOMAINS.has(domain.type)) fail(`${where}.${name}: a typed leaf's domain holds a string`);
      this.checkScopeFamily(`${where}.${name}`, scope, target, scopeKind, fail);
      return new Leaf({ name, base, path, t, scope: structuredClone(scope), nullable: nullable === true, role: role ?? 'ordinary', annotated: true });
    });
    const declared = [...shorthands, ...leaves];
    for (const leaf of leaves) {
      if (declared.some((other) => other !== leaf && (samePath(other.path, leaf.path) || isPrefix(other.path, leaf.path) || isPrefix(leaf.path, other.path)))) {
        fail(`${where}.${leaf.name}: a leaf is declared once and never inside another`);
      }
      if (leaf.scope.kind !== 'treeFrom') continue;
      const source = declared.find((other) => samePath(other.path, leaf.scope.path));
      const governing = this.registry.governingType;
      if (!source || !governing || source.t !== governing.type || source.role !== 'ordinary') {
        fail(`${where}.${leaf.name}: treeFrom names an ordinary leaf of the governing type in the same declaration`);
      }
      leaf.scope.source = source;
    }
    return leaves;
  }

  checkScopeFamily(where, scope, target, holderKind, fail) {
    if (!isPlainObject(scope)) fail(`${where}: scope is an object`);
    const keys = Object.keys(scope).sort().join();
    const local = target.scope === 'tree' || target.scope === 'overlay';
    switch (scope.kind) {
      case 'origin':
        if (keys !== 'kind') fail(`${where}: an origin scope holds kind only`);
        if (local && holderKind !== 'tree' && holderKind !== 'overlay') fail(`${where}: ${target.type} lives in no scope the holder's origin names`);
        return;
      case 'fixed': {
        if (keys !== 'kind,value') fail(`${where}: a fixed scope holds kind and value`);
        const product = PRODUCT_SCOPE.exec(typeof scope.value === 'string' ? scope.value : '')?.[1];
        if (!product || !Object.hasOwn(this.registry.products, product)) fail(`${where}: a fixed scope is self/<a declared product>`);
        if (target.scope !== `product:${product}`) fail(`${where}: ${target.type} does not live in ${scope.value}`);
        return;
      }
      case 'treeFrom':
        if (keys !== 'kind,path' || !isPath(scope.path)) fail(`${where}: a treeFrom scope holds kind and a property path`);
        if (!local) fail(`${where}: treeFrom names a tree or overlay scope, where ${target.type} does not live`);
        return;
      default:
        fail(`${where}: scope kind is origin, fixed or treeFrom`);
    }
  }

  recordLeaves(t) {
    return this.records.get(t) ?? [];
  }

  commandLeaves(name) {
    return this.commands.get(name) ?? [];
  }

  // D-10: a reference names a record in the scope its leaf declares. `origin` is the scope its type
  // lives in, seen from the holder's scope: a product scope, or the tree and overlay scopes of the
  // holder's tree. Null when a treeFrom source holds no id.
  scopeOf(leaf, holder, holderScope) {
    switch (leaf.scope.kind) {
      case 'fixed':
        return leaf.scope.value;
      case 'treeFrom': {
        const source = leaf.scope.source.find(holder);
        if (source.state !== 'value' || typeof source.value !== 'string') return null;
        return this.registry.type(leaf.t).scope === 'tree' ? `tree/${source.value}` : `self/overlay/${source.value}`;
      }
      default: {
        if (leaf.role === 'identity') return holderScope;
        const kind = this.registry.type(leaf.t)?.scope;
        if (kind?.startsWith('product:')) return `self/${kind.slice('product:'.length)}`;
        const tree = holderScope.split('/').pop();
        return kind === 'tree' ? `tree/${tree}` : `self/overlay/${tree}`;
      }
    }
  }

  // Every resolved identity of `leaves` in a holder of `holderScope`: `{leaf, scope, t, id}`. Each id is a
  // copy: a tuple identity is the holder's own array, which a later rename writes into.
  resolve(leaves, holder, holderScope) {
    const found = [];
    for (const leaf of leaves) {
      const at = leaf.find(holder);
      if (at.state !== 'value' || (leaf.role !== 'identity' && typeof at.value !== 'string')) continue;
      const scope = this.scopeOf(leaf, holder, holderScope);
      if (scope !== null) found.push({ leaf, scope, t: leaf.t, id: structuredClone(at.value) });
    }
    return found;
  }

  // The ordinary references a record holds, its key parts and field values: what makes it a dependent.
  ofRecord(scope, record) {
    return this.resolve(this.recordLeaves(record.t).filter((leaf) => leaf.role === 'ordinary'), record, scope);
  }

  // A command's references of one role: `ordinary` names existing records, `creation` proposes new ones.
  ofCommand(scope, cmd, role = 'ordinary') {
    if (!isPlainObject(cmd?.args)) return [];
    return this.resolve(this.commandLeaves(cmd.name).filter((leaf) => leaf.role === role), cmd, scope);
  }

  // A record, a row or a guard renamed by `map`, in place: global leaves first, then the scoped leaves
  // resolved again from the renamed values (so a treeFrom scope follows its renamed tree).
  remapRecord(scope, record, map) {
    this.remap(this.recordLeaves(record.t), record, scope, map, new Map());
  }

  // A command's arguments renamed by `map`, except its creations, which only `moves` (its own retained
  // source-to-target identities, §7.7 write map step 0) rename.
  remapCommand(scope, cmd, map, moves = new Map()) {
    if (isPlainObject(cmd?.args)) this.remap(this.commandLeaves(cmd.name), cmd, scope, map, moves);
  }

  // Each pass reads every leaf before it writes one, so no mapping feeds another; a place two leaves
  // share (a key that is also the record's own id) is written once.
  remap(leaves, holder, scope, map, moves) {
    const isGlobal = (leaf) => this.registry.type(leaf.t)?.idSpace === 'global';
    const renamed = new Set();
    const rename = (references, targetOf) => {
      const writes = references.flatMap((reference) => {
        const id = targetOf(reference);
        return id === undefined ? [] : [{ leaf: reference.leaf, id }];
      });
      for (const { leaf, id } of writes) {
        const place = jcs([...leaf.base, ...leaf.path]);
        if (renamed.has(place)) continue;
        renamed.add(place);
        assign(holder, leaf, id);
      }
    };
    rename(this.resolve(leaves, holder, scope), ({ leaf, t, id }) => moves.get(`${t}|${jcs(id)}`)
      ?? (leaf.role !== 'creation' && isGlobal(leaf) ? map.globalTarget(t, id) : undefined));
    const local = leaves.filter((leaf) => leaf.role !== 'creation' && !isGlobal(leaf));
    rename(this.resolve(local, holder, map.scope(scope)), ({ scope: named, t, id }) => map.scopedTarget(named, t, id));
  }

  // §6.1 step 2 for one field value: each annotated leaf present holds an id of its type (E-2's bounds
  // included), null only where nullable, under objects all the way down; a present treeFrom leaf's
  // source is present too. Answers the first reason, or null.
  checkValue(field, value) {
    const annotated = this.annotatedFields.get(field);
    if (!annotated) return null;
    return this.check(annotated.leaves, { f: { [annotated.name]: [value] } });
  }

  checkArguments(command, args) {
    return this.check(this.commandLeaves(command.name).filter((leaf) => leaf.annotated), { args });
  }

  check(leaves, holder) {
    for (const leaf of leaves) {
      const at = leaf.find(holder);
      if (at.state === 'malformed') return `${leaf.name} lies under a value that is not an object`;
      if (at.state === 'null' && !leaf.nullable) return `${leaf.name} is null`;
      if (at.state !== 'value') continue;
      const reason = typeof at.value === 'string' ? checkId(this.registry, this.registry.type(leaf.t), at.value) : 'not a string id';
      if (reason) return `${leaf.name} ${reason}`;
      if (leaf.scope.kind === 'treeFrom' && leaf.scope.source.find(holder).state !== 'value') return `${leaf.name} names no tree`;
    }
    return null;
  }
}

function isPath(path) {
  return Array.isArray(path) && path.length > 0 && path.every((part) => typeof part === 'string' && NAME.test(part));
}

// The domain a property path reaches through object domains; undefined once a json domain, or no
// domain, leaves the shape open. A path into any other shape is no object path at all.
function domainAlong(domain, path) {
  let current = domain;
  for (const part of path) {
    if (current === undefined || current.type === 'json') return undefined;
    if (current.type !== 'object' || !Object.hasOwn(current.properties, part)) return { type: 'none' };
    current = current.properties[part];
  }
  return current;
}

// Writes `id` at a leaf. A field's register is replaced, never edited, so no other holder sharing it moves.
function assign(holder, leaf, id) {
  if (leaf.base[0] === 'f') {
    const [, name] = leaf.base;
    const [value, stamp] = holder.f[name];
    holder.f[name] = [structuredClone(value), stamp];
  }
  const at = leaf.find(holder);
  if (at.parent === undefined) return;
  at.parent[at.key] = structuredClone(id);
}
