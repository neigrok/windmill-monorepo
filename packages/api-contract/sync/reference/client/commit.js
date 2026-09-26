// §7.1 commit(scope, changes, opts): one gesture, one local transaction. The change language is in
// corpus/README.md ("Changes").

import { Clock } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { derive } from '../core/derive.js';
import { jcs, sameJson } from '../core/jcs.js';
import { INTENT_MACHINE, transition } from '../core/machines.js';
import { Registry } from '../core/registry.js';
import { recordKey } from '../core/rows.js';
import { roundToQuantum } from '../core/values.js';
import { coalesce } from './coalesce.js';
import { drawn, stored } from './views.js';

export class CommitError extends Error {}

export function baseTextKey(t, id, field) {
  return jcs([t, id, field]);
}

class DeltaBuilder {
  constructor({ registry, replica, scope, stamp, physNow, drawnView }) {
    Object.assign(this, { registry, replica, scope, stamp, physNow, drawnView });
    this.chosen = new Set();
    this.baseTexts = {};
  }

  typeOf(change) {
    const type = this.registry.type(change.t);
    if (!type || type.scope !== this.registry.scopeKindOf(this.scope)) throw new CommitError(`${change.t} does not live in ${this.scope}`);
    return type;
  }

  delta(change) {
    const type = this.typeOf(change);
    switch (change.op) {
      case 'create':
        return this.create(type, change);
      case 'update':
        return this.update(type, change);
      case 'delete':
        return this.remove(type, change);
      case 'revive':
        return this.revive(type, change);
      case 'put':
        return this.put(type, change);
      case 'write':
        return this.write(type, change);
      default:
        throw new CommitError(`unknown change ${change.op}`);
    }
  }

  // A command's prediction: a create or an update of any field, server-written ones included.
  predicted(change) {
    const type = this.typeOf(change);
    const current = this.drawnView.get(recordKey(change.t, change.id));
    const delta = { t: change.t, id: change.id };
    if (change.op === 'create') {
      delta.born = this.stamp;
      delta.life = ['alive', this.stamp];
    } else if (type.hasBorn) {
      if (!current) throw new CommitError(`predicted update of ${change.t} ${change.id} absent from drawn`);
      delta.born = current.born;
    }
    const f = this.fields(type, change.f, change.op === 'create' ? undefined : current, { server: true });
    if (Object.keys(f).length) delta.f = f;
    return delta;
  }

  takenIds(type) {
    const taken = new Set(this.chosen);
    for (const record of this.drawnView.values()) if (record.t === type.type) taken.add(record.id);
    for (const spent of Object.values(this.replica.spentIds[this.scope] ?? {})) if (spent.t === type.type) taken.add(spent.id);
    return taken;
  }

  create(type, change) {
    if (!type.hasBorn) throw new CommitError(`${type.type} is created by put or write`);
    const id = type.identity === 'derived' && change.id === undefined
      ? derive(change.label, type.derive.fallback, this.takenIds(type))
      : change.id;
    this.chosen.add(id);
    if (this.drawnView.has(recordKey(type.type, id))) return null;
    const delta = { t: type.type, id, born: this.stamp, life: ['alive', this.stamp] };
    const f = this.fields(type, change.f, undefined, { create: true });
    if (Object.keys(f).length) delta.f = f;
    const x = this.texts(type, id, change.x, undefined);
    if (Object.keys(x).length) delta.x = x;
    return delta;
  }

  existing(type, change) {
    const current = this.drawnView.get(recordKey(type.type, change.id));
    if (!current) throw new CommitError(`${change.op} of ${type.type} ${JSON.stringify(change.id)} absent from drawn`);
    return current;
  }

  update(type, change) {
    if (!type.hasBorn) throw new CommitError(`${type.type} is updated by put or write`);
    const current = this.existing(type, change);
    const delta = { t: type.type, id: change.id, born: current.born };
    return this.withChanges(type, delta, change, current) ? delta : null;
  }

  remove(type, change) {
    if (type.identity === 'keyed') return this.put(type, { ...change, present: false });
    if (!type.hasBorn) throw new CommitError(`${type.type} has no life`);
    const current = this.existing(type, change);
    return { t: type.type, id: change.id, born: current.born, life: ['dead', this.stamp] };
  }

  revive(type, change) {
    if (!type.hasBorn) throw new CommitError(`${type.type} is not revived`);
    const current = this.drawnView.get(recordKey(type.type, change.id));
    const born = current?.born ?? this.replica.spentBorn(this.scope, type.type, change.id);
    if (born === undefined) throw new CommitError(`revive of ${type.type} ${change.id} without a born`);
    const delta = { t: type.type, id: change.id, born, life: ['alive', this.stamp] };
    const f = this.fields(type, change.f, current);
    if (Object.keys(f).length) delta.f = f;
    return delta;
  }

  put(type, change) {
    if (type.identity !== 'keyed' || !type.life) throw new CommitError(`${type.type} is not keyed with life`);
    const current = this.drawnView.get(recordKey(type.type, change.id));
    const presentBefore = current?.life?.[0] === 'alive';
    const present = change.present ?? true;
    let life = current?.life;
    if (present && !presentBefore) life = ['alive', this.stamp];
    if (!present && presentBefore) life = ['dead', this.stamp];
    if (life === undefined) return null;
    const delta = { t: type.type, id: change.id, life };
    const changed = this.withChanges(type, delta, change, current);
    return changed || !sameJson(life, current?.life ?? null) ? delta : null;
  }

  write(type, change) {
    if (type.life) throw new CommitError(`${type.type} has life`);
    const current = this.drawnView.get(recordKey(type.type, change.id));
    const delta = { t: type.type, id: change.id };
    return this.withChanges(type, delta, change, current) ? delta : null;
  }

  withChanges(type, delta, change, current) {
    const f = this.fields(type, change.f, current);
    if (Object.keys(f).length) delta.f = f;
    const x = this.texts(type, change.id, change.x, current);
    if (Object.keys(x).length) delta.x = x;
    return delta.f !== undefined || delta.x !== undefined;
  }

  fields(type, values = {}, current, { create = false, server = false } = {}) {
    const out = {};
    for (const [name, raw] of Object.entries(values)) {
      const field = type.field(name);
      if (!field || !Registry.isLattice(field.kind)) throw new CommitError(`${type.type}.${name} is not a lattice field`);
      if (field.writer === 'server' && !server) throw new CommitError(`${type.type}.${name} is written by the server`);
      const value = field.quantum !== undefined && typeof raw === 'number' ? roundToQuantum(raw, field.quantum) : raw;
      if (current?.f?.[name] && sameJson(current.f[name][0], value)) continue;
      out[name] = [value, this.stamp];
    }
    if (create) {
      for (const name of type.fieldNames((field) => field.kind === 'time' && field.writer === 'client')) {
        out[name] ??= [this.physNow, this.stamp];
      }
    }
    return Object.fromEntries(Object.keys(out).sort().map((name) => [name, out[name]]));
  }

  texts(type, id, values = {}, current) {
    const out = {};
    for (const [name, raw] of Object.entries(values)) {
      if (type.field(name)?.kind !== 'text') throw new CommitError(`${type.type}.${name} is not a text field`);
      const shown = current?.x?.[name] ?? '';
      const { text, from } = typeof raw === 'string' ? { text: raw, from: shown } : { text: raw.text, from: raw.from ?? shown };
      if (text === shown) continue;
      const confirmed = this.replica.confirmedRow(this.scope, type.type, id)?.x?.[name];
      out[name] = { text, base: confirmed && confirmed.text === from ? { rev: confirmed.rev } : { text: from } };
      this.baseTexts[baseTextKey(type.type, id, name)] = from;
    }
    return out;
  }
}

function refusalOfScope(replica, registry, scope) {
  const kind = registry.scopeKindOf(scope);
  if (kind !== 'tree' && kind !== 'overlay') return null;
  const tree = scope.split('/').pop();
  if (replica.known[scope] || replica.known[`tree/${tree}`]) return 'scope-dead';
  const governing = registry.governingType;
  const productScope = `self/${registry.productOfScopeKind(governing.scope)}`;
  const record = stored(replica, registry, productScope).get(recordKey(governing.type, tree));
  return record?.life?.[0] === 'dead' ? 'scope-dead' : null;
}

function guardsOf(opts, deltas, storedView) {
  if (!opts.guard) return [];
  const named = [];
  for (const delta of deltas) for (const field of Object.keys(delta.f ?? {})) named.push({ t: delta.t, id: delta.id, field });
  if (Array.isArray(opts.guard)) named.push(...opts.guard);
  const guards = new Map();
  for (const { t, id, field } of named) {
    const stamp = storedView.get(recordKey(t, id))?.f?.[field]?.[1] ?? null;
    guards.set(jcs([t, id, field]), { t, id, field, stamp });
  }
  return [...guards.values()];
}

function intentOf(scope, deltas, guards, cmd, gestureId) {
  const intent = { scope };
  if (deltas.length) intent.d = deltas;
  if (guards.length) intent.guard = guards;
  if (cmd) intent.cmd = cmd;
  intent.gestureId = gestureId;
  return intent;
}

function groupIntents(scope, deltas, guards, opts, gestureId) {
  if (opts.atomic || opts.hold || opts.cmd) {
    return deltas.length || opts.cmd ? [intentOf(scope, deltas, guards, opts.cmd, gestureId)] : [];
  }
  const intents = deltas.map((delta) => intentOf(scope, [delta], guards.filter((g) => g.t === delta.t && sameJson(g.id, delta.id)), undefined, gestureId));
  const unplaced = guards.filter((g) => !deltas.some((delta) => g.t === delta.t && sameJson(g.id, delta.id)));
  if (unplaced.length && intents.length) intents[0].guard = [...(intents[0].guard ?? []), ...unplaced];
  return intents;
}

// ctx: {registry, actor, deviceNow, ended, nextGestureId?, limits?}. Answers {localIds, stamp} or {refused}.
// A throw writes nothing: the stamp is written back only once every delta is built.
export function commit(replica, ctx, scope, changes, opts = {}) {
  const { registry } = ctx;
  const limits = ctx.limits ?? CONSTANTS;
  if (replica.meta.state !== 'anon' && replica.meta.state !== 'bound') throw new CommitError(`a ${replica.meta.state} replica does not commit`);
  const scopeRefusal = refusalOfScope(replica, registry, scope);
  if (scopeRefusal) return { refused: scopeRefusal };

  const physNow = ctx.deviceNow + replica.meta.serverOffsetMs;
  const clock = new Clock(replica.meta.hlc, ctx.actor, () => physNow);
  clock.observe(replica.meta.hlcHigh);
  const stamp = clock.tick();

  const drawnView = drawn(replica, registry, scope);
  const builder = new DeltaBuilder({ registry, replica, scope, stamp, physNow, drawnView });
  const deltas = changes.map((change) => builder.delta(change)).filter((delta) => delta !== null);
  const predict = (opts.predict ?? []).map((change) => builder.predicted(change));
  const guards = guardsOf(opts, deltas, stored(replica, registry, scope));
  const gestureId = opts.gestureId ?? ctx.nextGestureId();
  const intents = groupIntents(scope, deltas, guards, opts, gestureId);
  replica.meta.hlc = clock.pair;

  const oversize = intents.find((intent) => Buffer.byteLength(jcs(intent), 'utf8') > limits.PUSH_MAX_BYTES);
  if (oversize) {
    const content = {};
    if (deltas.length) content.d = deltas;
    if (opts.cmd) content.cmd = opts.cmd;
    replica.notices.push({ id: `notice:${gestureId}/0`, scope, code: 'too-large', content, at: ctx.deviceNow });
    return { refused: 'too-large' };
  }

  const firstOrder = replica.nextCommitOrder();
  const entries = intents.map((intent, k) => {
    const state = transition(INTENT_MACHINE, null, 'commit', opts.hold ? 'held' : 'ready');
    const entry = {
      localId: `${gestureId}/${k}`,
      gestureId,
      lineage: replica.lineage(),
      scope,
      state,
      commitOrder: firstOrder + k,
      releaseAt: opts.hold ? ctx.deviceNow + limits.HOLD_MS : 0,
      stamp,
      intent,
    };
    if (opts.cmd && predict.length) entry.predict = predict;
    const texts = {};
    for (const delta of intent.d ?? []) {
      for (const name of Object.keys(delta.x ?? {})) {
        const key = baseTextKey(delta.t, delta.id, name);
        texts[key] = builder.baseTexts[key];
      }
    }
    if (Object.keys(texts).length) entry.baseTexts = texts;
    return entry;
  });
  replica.outbox.push(...entries);
  for (const entry of entries) coalesce(replica, registry, ctx.ended, entry);

  const product = registry.productOfRef(scope);
  for (const [key, value] of Object.entries(opts.local ?? {})) {
    if (value === null) delete replica.deviceRows(product)[key];
    else replica.deviceRows(product)[key] = value;
  }
  replica.meta.hlcHigh = stamp;
  return { localIds: entries.map((entry) => entry.localId), stamp };
}
