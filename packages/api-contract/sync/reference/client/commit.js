// §7.1 commit(scope, changes, opts): one gesture, one local transaction. The change language is in
// corpus/README.md ("Changes").

import { Clock } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { derive, mintId } from '../core/derive.js';
import { OrderKeyError, dropKey } from '../core/fracindex.js';
import { jcs, sameJson } from '../core/jcs.js';
import { INTENT_MACHINE, moveEntry, transition } from '../core/machines.js';
import { Registry } from '../core/registry.js';
import { isVisible, recordKey } from '../core/rows.js';
import { roundToDomain } from '../core/values.js';
import { holdsNul, widestAloneBytes } from '../core/wire.js';
import { deltasOf, foldSilently, silentFoldOf } from './dependents.js';
import { drawn, foldDelta, stored, visibleCount } from './views.js';

// §7.1's failures before the transaction commits: `not-writable`, a replica whose state forbids
// writes, or `malformed`, a programming error. The in-memory reference has no store failure.
export class CommitError extends Error {
  constructor(message, kind = 'malformed') {
    super(message);
    this.kind = kind;
  }
}

export function baseTextKey(t, id, field) {
  return jcs([t, id, field]);
}

class DeltaBuilder {
  constructor({ registry, replica, scope, stamp, physNow, drawnView, storedView, draw }) {
    Object.assign(this, { registry, replica, scope, stamp, physNow, drawnView, storedView, draw });
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
    if (change.anchor !== undefined && change.op !== 'create' && change.op !== 'move') throw new CommitError(`a ${change.op} carries no anchor`);
    switch (change.op) {
      case 'create':
        return this.create(type, change);
      case 'move':
        return this.move(type, change);
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

  // A command's prediction may write server fields and text, and change record presence.
  predicted(change) {
    const type = this.typeOf(change);
    const current = this.drawnView.get(recordKey(change.t, change.id));
    const delta = { t: change.t, id: change.id };
    if (change.op === 'delete') {
      if (!type.life) throw new CommitError(`${type.type} has no life`);
      if (type.hasBorn) {
        if (!current) throw new CommitError(`predicted delete of ${change.t} ${change.id} absent from drawn`);
        delta.born = current.born;
      }
      delta.life = ['dead', this.stamp];
      return delta;
    }
    if (!['create', 'update', 'put', 'write'].includes(change.op)) throw new CommitError('a prediction is a create, update, delete, put or write');
    if (change.op === 'create' && type.life) {
      delta.born = this.stamp;
      delta.life = ['alive', this.stamp];
    } else if (type.hasBorn) {
      if (!current) throw new CommitError(`predicted update of ${change.t} ${change.id} absent from drawn`);
      delta.born = current.born;
    }
    if (change.op === 'put' && type.identity === 'keyed' && type.life) {
      if (change.present === undefined && !current) throw new CommitError(`predicted put keeping the presence of ${change.t} ${change.id} absent from drawn`);
      const presentBefore = current?.life?.[0] === 'alive';
      const present = change.present ?? presentBefore;
      let life = current?.life;
      if (present && (!presentBefore || type.wholePut)) life = ['alive', this.stamp];
      if (!present && presentBefore) life = ['dead', this.stamp];
      if (life !== undefined) delta.life = life;
    }
    const f = this.fields(type, change.f, change.op === 'create' ? undefined : current, { server: true });
    if (Object.keys(f).length) delta.f = f;
    const x = this.texts(type, change.id, change.x, current, { server: true });
    if (Object.keys(x).length) delta.x = x;
    return delta;
  }

  takenIds(type) {
    const taken = new Set(this.chosen);
    for (const record of this.drawnView.values()) if (record.t === type.type) taken.add(record.id);
    for (const spent of Object.values(this.replica.spentIds[this.scope] ?? {})) if (spent.t === type.type) taken.add(spent.id);
    return taken;
  }

  // §7.1 step 5: the change's id; else a derived id from its label (D-26); else an id minted by the
  // type's mint (D-8), drawn again while taken.
  idOf(type, change) {
    if (change.id !== undefined) return change.id;
    const taken = this.takenIds(type);
    if (type.identity === 'derived' && change.label !== undefined) return derive(change.label, type.derive.fallback, taken);
    let id = mintId(type, this.draw);
    while (taken.has(id)) id = mintId(type, this.draw);
    return id;
  }

  create(type, change) {
    if (!type.hasBorn) throw new CommitError(`${type.type} is created by put or write`);
    const id = this.idOf(type, change);
    this.chosen.add(id);
    const values = change.anchor === undefined ? change.f : this.placed(type, id, change.f, change.anchor);
    if (this.drawnView.has(recordKey(type.type, id))) return null;
    const delta = { t: type.type, id, born: this.stamp, life: ['alive', this.stamp] };
    const f = this.fields(type, values, undefined, { create: true });
    if (Object.keys(f).length) delta.f = f;
    const x = this.texts(type, id, change.x, undefined);
    if (Object.keys(x).length) delta.x = x;
    return delta;
  }

  // §7.1 step 4: a move writes only its anchor's order field, by an update; only minted and derived
  // types hold an order field (§2.4).
  move(type, change) {
    if (change.anchor === undefined) throw new CommitError('a move carries an anchor');
    return this.update(type, { op: 'update', id: change.id, f: this.placed(type, change.id, {}, change.anchor) });
  }

  // The change's values with the anchor's order field at D-25's drop position: the anchor `below` is
  // looked up in drawn, then in stored, and the list is the type's visible records that hold the field.
  placed(type, id, values = {}, { field, below }) {
    if (type.field(field)?.domain?.type !== 'fracKey') throw new CommitError(`${type.type}.${field} is not an order field`);
    if (values[field] !== undefined) throw new CommitError(`${type.type}.${field} is written beside an anchor`);
    const members = (records) => [...records.values()]
      .filter((record) => record.t === type.type && isVisible(type, record) && record.f?.[field] !== undefined)
      .map((record) => ({ id: record.id, key: record.f[field][0] }));
    try {
      return { ...values, [field]: dropKey({ stored: members(this.storedView), drawn: members(this.drawnView), moved: id, above: below }) };
    } catch (error) {
      if (error instanceof OrderKeyError) throw new CommitError(error.message);
      throw error;
    }
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
    if (type.wholePut && present) return this.wholePut(type, change);
    if (type.wholePut && Object.keys({ ...change.f, ...change.x }).length) throw new CommitError(`a removal of ${type.type} carries its life alone`);
    let life = current?.life;
    if (present && !presentBefore) life = ['alive', this.stamp];
    if (!present && presentBefore) life = ['dead', this.stamp];
    if (life === undefined) return null;
    const delta = { t: type.type, id: change.id, life };
    const changed = this.withChanges(type, delta, change, current);
    return changed || !sameJson(life, current?.life ?? null) ? delta : null;
  }

  // §7.1 step 4: a put that leaves a `wholePut` record present writes every client-written lattice field,
  // changed or not, and asserts presence with a fresh life, all at the gesture's stamp. A `wholePut` type
  // has no text field (§2.4), so a text edit names a field it does not have and throws, as it does on
  // any type.
  wholePut(type, change) {
    const [text] = Object.keys(change.x ?? {});
    if (text !== undefined) throw new CommitError(`${type.type}.${text} is not a text field`);
    const missing = type.clientLatticeFieldNames.filter((name) => change.f?.[name] === undefined);
    if (missing.length) throw new CommitError(`a whole put of ${type.type} leaves out ${missing.join(', ')}`);
    return { t: type.type, id: change.id, life: ['alive', this.stamp], f: this.fields(type, change.f, undefined) };
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
      const value = roundToDomain(field.domain, raw);
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

  texts(type, id, values = {}, current, { server = false } = {}) {
    const out = {};
    for (const [name, raw] of Object.entries(values)) {
      if (type.field(name)?.kind !== 'text') throw new CommitError(`${type.type}.${name} is not a text field`);
      if (type.field(name).writer === 'server' && !server) throw new CommitError(`${type.type}.${name} is written by the server`);
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

// §7.1 step 4: a move and an update of one record fold into one delta, the update leaving the move's
// field alone. Step 7: any other changes that give one record two deltas throw.
function oneDeltaPerRecord(built) {
  const byRecord = new Map();
  const deltas = [];
  for (const { change, delta } of built) {
    const key = recordKey(delta.t, delta.id);
    const earlier = byRecord.get(key);
    if (!earlier) {
      byRecord.set(key, { changes: [change], delta });
      deltas.push(delta);
      continue;
    }
    const pair = [...earlier.changes, change];
    const move = pair.find((one) => one.op === 'move');
    const update = pair.find((one) => one.op === 'update');
    if (pair.length !== 2 || !move || !update) throw new CommitError('an intent changes a record at most once');
    if (update.f?.[move.anchor.field] !== undefined) throw new CommitError(`${delta.t}.${move.anchor.field} is written beside a move`);
    earlier.changes.push(change);
    earlier.delta.f = Object.fromEntries(Object.entries({ ...earlier.delta.f, ...delta.f }).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (delta.x) earlier.delta.x = { ...earlier.delta.x, ...delta.x };
  }
  return deltas;
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

// §7.1 step 6: exactly the listed registers `{t, id, field}`, each at its stamp in stored, null when
// unset. A field the type does not declare as a lattice field (`life` and text fields included) throws.
function guardsOf(registry, scope, listed, storedView) {
  if (!Array.isArray(listed)) throw new CommitError('guard lists registers');
  const guards = new Map();
  for (const { t, id, field } of listed) {
    const type = registry.type(t);
    if (!type || type.scope !== registry.scopeKindOf(scope)) throw new CommitError(`a guard on ${t} does not live in ${scope}`);
    if (!Registry.isLattice(type.field(field)?.kind)) throw new CommitError(`${t}.${field} is not a guardable register`);
    const stamp = storedView.get(recordKey(t, id))?.f?.[field]?.[1] ?? null;
    guards.set(jcs([t, id, field]), { t, id, field, stamp });
  }
  return [...guards.values()];
}

// §7.1 step 4: a command's arguments, every number rounded to its argument domain's quantum at any depth.
// An unknown command or argument is left as it is, for admission to refuse.
function roundedCommand(registry, cmd) {
  const def = registry.command(cmd.name);
  if (!def || cmd.args === null || typeof cmd.args !== 'object' || Array.isArray(cmd.args)) return cmd;
  return { ...cmd, args: Object.fromEntries(Object.entries(cmd.args).map(([name, value]) => [name, roundToDomain(def.args[name]?.domain, value)])) };
}

function intentOf(scope, deltas, guards, cmd, gestureId) {
  const intent = { scope };
  if (deltas.length) intent.d = deltas;
  if (guards.length) intent.guard = guards;
  if (cmd) intent.cmd = cmd;
  intent.gestureId = gestureId;
  return intent;
}

function groupIntents(scope, deltas, guards, opts, cmd, gestureId) {
  if (opts.atomic || opts.hold || cmd) {
    return deltas.length || cmd ? [intentOf(scope, deltas, guards, cmd, gestureId)] : [];
  }
  const intents = deltas.map((delta) => intentOf(scope, [delta], guards.filter((g) => g.t === delta.t && sameJson(g.id, delta.id)), undefined, gestureId));
  const unplaced = guards.filter((g) => !deltas.some((delta) => g.t === delta.t && sameJson(g.id, delta.id)));
  if (unplaced.length && intents.length) intents[0].guard = [...(intents[0].guard ?? []), ...unplaced];
  return intents;
}

// §7.1 step 8: the capped type the gesture's deltas, applied to `stored`, grow past its cap by the growth
// rule, or undefined. A held delete still occupies its slot.
function cappedType(registry, storedView, deltas) {
  const after = new Map(storedView);
  for (const delta of deltas) foldDelta(after, registry, delta);
  return [...new Set(deltas.map((delta) => delta.t))].find((t) => {
    const cap = registry.type(t).cap;
    if (cap === undefined) return false;
    const count = visibleCount(registry, after, t);
    return count > cap && count > visibleCount(registry, storedView, t);
  });
}

// §7.1 step 4: the held gestures of the scope that carry no command and whose every delta removes
// (life → dead) a record `retire` names, as their entries.
function retiringEntries(replica, scope, retire) {
  if (retire.length === 0) return [];
  const named = new Set(retire.map(({ t, id }) => recordKey(t, id)));
  const removes = (entry) => entry.intent.cmd === undefined && (entry.intent.d ?? []).length > 0
    && entry.intent.d.every((delta) => delta.life?.[0] === 'dead' && named.has(recordKey(delta.t, delta.id)));
  const gestures = new Map();
  for (const entry of replica.entries()) gestures.set(entry.gestureId, [...(gestures.get(entry.gestureId) ?? []), entry]);
  return [...gestures.values()].filter((gesture) => gesture.every((entry) => entry.state === 'held' && entry.scope === scope && removes(entry))).flat();
}

// Anonymous snapshots have never crossed a door: their entire unnumbered gesture may be replaced.
function supersedingEntries(replica, scope, gestureIds) {
  if (!Array.isArray(gestureIds)) throw new CommitError('supersede names gestures as an array');
  if (gestureIds.length === 0) return [];
  if (replica.meta.state !== 'anon' || new Set(gestureIds).size !== gestureIds.length) throw new CommitError('supersede requires distinct anonymous gestures');
  return gestureIds.flatMap((gestureId) => {
    const entries = replica.entries().filter((entry) => entry.gestureId === gestureId);
    if (entries.length === 0 || entries.some((entry) => entry.scope !== scope || !['held', 'ready'].includes(entry.state) || entry.n !== undefined)) {
      throw new CommitError('supersede requires a whole never-numbered gesture in this scope');
    }
    return entries;
  }).sort((a, b) => a.commitOrder - b.commitOrder);
}

// ctx: {registry, actor, deviceNow, ended, nextGestureId, draw, limits, device}; `device` holds every
// replica a given `opts.gestureId` is checked against. `changes` is a list with its `opts`, answering
// {localIds, retired, stamp} or {refused, detail?}; or the read-and-commit body, a function of the views,
// the commit's one physNow reading and the id of the replica it writes to {drawn, stored, now, replica}
// (§7.12), read in this transaction before the scope check, answering {gesture: {changes, opts} | null, value}, and then `commit` answers {outcome, value}.
// A null gesture writes nothing, ticks no clock and gives a null outcome. A throw writes nothing, and
// the body's own throw passes through unchanged.
export function commit(replica, ctx, scope, changes, opts = {}) {
  if (replica.meta.state !== 'anon' && replica.meta.state !== 'bound') throw new CommitError(`a ${replica.meta.state} replica does not commit`, 'not-writable');
  const physNow = ctx.deviceNow + replica.meta.serverOffsetMs;
  if (typeof changes !== 'function') return commitGesture(replica, ctx, physNow, scope, changes, opts);
  const { gesture, value } = changes({ drawn: drawn(replica, ctx.registry, scope), stored: stored(replica, ctx.registry, scope), now: physNow, replica: replica.id });
  if (!gesture) return { outcome: null, value };
  return { outcome: commitGesture(replica, ctx, physNow, scope, gesture.changes, gesture.opts ?? {}), value };
}

// §7.1 steps 2–11 on the commit's one physNow reading. The retire and the silent fold of its
// dependents are planned first, and the diff reads views without them. A cap refusal writes nothing,
// and a too-large refusal writes only its notice; neither retires. The clock is written back once the
// commit is accepted.
function commitGesture(replica, ctx, physNow, scope, changes, opts) {
  const { registry } = ctx;
  const limits = ctx.limits ?? CONSTANTS;
  if (opts.gestureId !== undefined && ctx.device.carriesGesture(opts.gestureId)) throw new CommitError(`gesture id ${opts.gestureId} is taken on the device`);
  const product = registry.productOfRef(scope);
  for (const key of Object.keys(opts.local ?? {})) {
    const rows = Object.values(registry.products[product]?.device ?? {});
    if (!rows.some((row) => new RegExp(row.keyPattern, 'u').test(key))) throw new CommitError(`device row ${key} matches no row of ${product}`);
  }
  const scopeRefusal = refusalOfScope(replica, registry, scope);
  if (scopeRefusal) return { refused: scopeRefusal };

  const clock = new Clock(replica.meta.hlc, ctx.actor, () => physNow);
  clock.observe(replica.meta.hlcHigh);
  const stamp = clock.tick();

  const retiring = retiringEntries(replica, scope, opts.retire ?? []);
  const superseding = supersedingEntries(replica, scope, opts.supersede ?? []);
  const ending = [...new Set([...retiring, ...superseding])];
  const folded = silentFoldOf(replica, registry, ending.map((entry) => ({ entry, deltas: deltasOf(entry) })));
  const gone = new Set([...ending.flatMap(deltasOf), ...folded.flatMap(({ entry, part }) => [...part.removed, ...(part.cmdGone ? entry.predict ?? [] : [])])]);
  const drawnView = drawn(replica, registry, scope, gone);
  const storedView = stored(replica, registry, scope, gone);
  const builder = new DeltaBuilder({ registry, replica, scope, stamp, physNow, drawnView, storedView, draw: ctx.draw });
  const deltas = oneDeltaPerRecord(changes.map((change) => ({ change, delta: builder.delta(change) })).filter(({ delta }) => delta !== null));
  const predict = (opts.predict ?? []).map((change) => builder.predicted(change));
  const guards = guardsOf(registry, scope, opts.guard ?? [], storedView);
  const cmd = opts.cmd === undefined ? undefined : roundedCommand(registry, opts.cmd);
  if (holdsNul({ scope, d: deltas, guard: guards, cmd, gestureId: opts.gestureId })) throw new CommitError('a string of the intents holds U+0000');
  const capped = cappedType(registry, storedView, deltas);
  if (capped !== undefined) return { refused: 'cap', detail: { type: capped, cap: registry.type(capped).cap } };
  const gestureId = opts.gestureId ?? ctx.nextGestureId();
  const intents = groupIntents(scope, deltas, guards, opts, cmd, gestureId);

  const oversize = intents.find((intent) => widestAloneBytes(replica.meta, intent) > limits.PUSH_MAX_BYTES);
  if (oversize) {
    const content = {};
    if (deltas.length) content.d = deltas;
    if (cmd) content.cmd = cmd;
    replica.notices.push({ id: `notice:${gestureId}/0`, scope, code: 'too-large', content, at: ctx.deviceNow });
    return { refused: 'too-large' };
  }

  for (const entry of retiring) moveEntry(replica, ctx.ended, entry, 'retire');
  for (const entry of superseding) if (replica.entry(entry.localId)) moveEntry(replica, ctx.ended, entry, 'silent-fold');
  foldSilently(replica, ctx.ended, folded);
  replica.meta.hlc = clock.pair;
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
    if (cmd && predict.length) entry.predict = predict;
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

  for (const [key, value] of Object.entries(opts.local ?? {})) {
    if (value === null) delete replica.deviceRows(product)[key];
    else replica.deviceRows(product)[key] = value;
  }
  replica.meta.hlcHigh = stamp;
  const outcome = { localIds: entries.map((entry) => entry.localId), retired: [...new Set(retiring.map((entry) => entry.gestureId))], stamp };
  if (superseding.length > 0) outcome.superseded = [...new Set(superseding.map((entry) => entry.gestureId))];
  return outcome;
}
