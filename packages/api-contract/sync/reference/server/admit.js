// §6.1 admit(origin, intent), a pure fail-fast pipeline: the result and the next state, or the given
// state on a refusal. Null stamps in server-built deltas are minted at step 9 (§10.3).

import { Clock } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { replaceRow } from '../core/digest.js';
import { jcs, sameJson } from '../core/jcs.js';
import { joinRecord } from '../core/merge.js';
import { Registry } from '../core/registry.js';
import { compactRow, isAlive, latticeOf, recordKey, stampsOf, thinRow } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { checkArgument, checkFieldValue, checkId, lengthIn } from '../core/values.js';
import { holdsNul } from '../core/wire.js';
import { accessOf, scopeKeyOf } from './access.js';
import { decide, opOf } from './identity.js';
import { mergeText, mergedFlag } from './textmerge.js';

export class Refusal extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const DELTA_KEYS = new Set(['t', 'id', 'life', 'born', 'f', 'x', 'v']);
const INTENT_KEYS = new Set(['n', 'scope', 'd', 'guard', 'cmd', 'gestureId']);
const TEXT_WRITE_KEYS = new Set(['text', 'base']);

// A command's internal replacement; the public delta shape never accepts these markers.
export function replacementText(text, { archiveNonempty = false, archive = {} } = {}) {
  return { text, replace: true, archiveNonempty, archive };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// §6.1 step 2: a delta of a `wholePut` type carries a life; an alive one carries every client-written
// lattice field, every register at the life's stamp (null alike from a server origin), and a dead one no
// field register, so a losing delete plants nothing.
function isWholeDelta(type, delta) {
  if (delta.life === undefined) return false;
  const registers = delta.f ?? {};
  if (delta.life[0] !== 'alive') return Object.keys(registers).length === 0;
  return type.clientLatticeFieldNames.every((name) => Object.hasOwn(registers, name))
    && Object.values(registers).every((register) => register[1] === delta.life[1]);
}

// Answers {result, state, writes, killed}: `writes` lists each changed scope's applied rows, the
// intent's scope first, then scopes it created (§6.1 step 14); `killed` the scopes a death killed.
export function admit({ state, registry, product, origin, intent, serverNow, limits = CONSTANTS }) {
  const admission = new Admission({ work: state.clone(), registry, product, origin, intent: structuredClone(intent), serverNow, limits });
  try {
    const result = admission.run();
    return { result, state: admission.work, writes: admission.writes, killed: admission.killed };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const result = { s: 'refused', code: error.code };
    if (error.detail !== undefined) result.detail = error.detail;
    return { result, state, writes: [], killed: [] };
  }
}

class Admission {
  constructor({ work, registry, product, origin, intent, serverNow, limits }) {
    Object.assign(this, { work, registry, product, origin, intent, serverNow, limits });
    this.fromServer = origin.kind === 'server';
    this.changes = [];
    this.records = new Map();
    this.writes = [];
    this.changed = [];
    this.killed = [];
  }

  run() {
    this.resolveScope();
    this.checkShape();
    this.lockScope();
    this.admitDeltas(this.intent.d ?? [], this.fromServer ? 'server' : 'client');
    this.checkGuards();
    this.runCommand();
    this.join();
    this.checkProduct();
    this.checkParents();
    this.assignSerials();
    this.checkCaps();
    this.apply(this.scopeKey);
    this.applyLifecycle();
    this.applyCreatedScopes();
    return this.result();
  }

  // Step 1.
  resolveScope() {
    this.scopeKind = this.registry.scopeKindOf(this.intent?.scope);
    const target = scopeKeyOf(this.registry, this.intent?.scope, this.origin.account);
    if (target === null) throw new Refusal('invalid');
    if (target.tree !== undefined && checkId(this.registry, this.registry.governingType, target.tree)) throw new Refusal('invalid');
    this.target = target;
    this.scopeKey = target.key;
  }

  // Step 2: registration, ids, stamps, §4.1 and §4.4's writer rules, values; then the skew bound and
  // the clamp of time values.
  checkShape() {
    const { intent } = this;
    if (!isObject(intent) || Object.keys(intent).some((key) => !INTENT_KEYS.has(key)) || holdsNul(intent)) throw new Refusal('invalid');
    const deltas = intent.d ?? [];
    if (!Array.isArray(deltas) || (deltas.length === 0 && intent.cmd === undefined)) throw new Refusal('invalid');
    const seen = new Set();
    for (const delta of deltas) {
      this.checkDeltaShape(delta);
      const key = recordKey(delta.t, delta.id);
      if (seen.has(key)) throw new Refusal('invalid');
      seen.add(key);
    }
    for (const guard of intent.guard ?? []) this.checkGuardShape(guard);
    if (intent.cmd !== undefined) this.checkCommandShape(intent.cmd);
    if (intent.gestureId !== undefined && typeof intent.gestureId !== 'string') throw new Refusal('invalid');
    for (const delta of deltas) this.checkDeltaValues(delta);
    const bound = this.serverNow + this.limits.MAX_SKEW_MS;
    if (deltas.flatMap(stampsOf).some((stamp) => stamp !== null && Stamp.parse(stamp).ms > bound)) throw new Refusal('clock-skew');
    this.clampTimes(deltas, bound);
  }

  isStampHere(stamp) {
    if (this.fromServer && stamp === null) return true;
    return Stamp.isValid(stamp) && stamp !== Stamp.UNSET;
  }

  checkDeltaShape(delta) {
    if (!isObject(delta) || Object.keys(delta).some((key) => !DELTA_KEYS.has(key))) throw new Refusal('invalid');
    const type = this.registry.type(delta.t);
    if (!type || type.scope !== this.scopeKind) throw new Refusal('invalid');
    if (checkId(this.registry, type, delta.id)) throw new Refusal('invalid');
    if (delta.v !== undefined) throw new Refusal('invalid');
    if (delta.life !== undefined) {
      const shaped = Array.isArray(delta.life) && delta.life.length === 2 && ['alive', 'dead'].includes(delta.life[0]);
      if (!shaped || !this.isStampHere(delta.life[1]) || !type.life) throw new Refusal('invalid');
    }
    if (delta.born !== undefined && !this.isStampHere(delta.born)) throw new Refusal('invalid');
    for (const [name, register] of Object.entries(delta.f ?? {})) {
      const field = type.field(name);
      if (!field || !Registry.isLattice(field.kind)) throw new Refusal('invalid');
      if (!Array.isArray(register) || register.length !== 2 || !this.isStampHere(register[1])) throw new Refusal('invalid');
      if (!this.fromServer && field.writer === 'server') throw new Refusal('invalid');
    }
    for (const [name, write] of Object.entries(delta.x ?? {})) {
      const field = type.field(name);
      if (!field || field.kind !== 'text' || !isObject(write) || Object.keys(write).some((key) => !TEXT_WRITE_KEYS.has(key)) || typeof write.text !== 'string' || !isObject(write.base)) throw new Refusal('invalid');
      if (!this.fromServer && field.writer === 'server') throw new Refusal('invalid');
      const byRev = Object.keys(write.base).length === 1 && Number.isSafeInteger(write.base.rev) && write.base.rev >= 0;
      const byText = Object.keys(write.base).length === 1 && typeof write.base.text === 'string';
      if (!byRev && !byText) throw new Refusal('invalid');
    }
    if (type.wholePut && !isWholeDelta(type, delta)) throw new Refusal('invalid');
    if (opOf(type, delta) === 'invalid') throw new Refusal('invalid');
  }

  checkDeltaValues(delta) {
    const type = this.registry.type(delta.t);
    for (const [name, register] of Object.entries(delta.f ?? {})) {
      if (checkFieldValue(this.registry, type.field(name), register[0])) throw new Refusal('invalid');
    }
  }

  checkGuardShape(guard) {
    if (!isObject(guard)) throw new Refusal('invalid');
    const type = this.registry.type(guard.t);
    if (!type || type.scope !== this.scopeKind || checkId(this.registry, type, guard.id)) throw new Refusal('invalid');
    const field = type.field(guard.field);
    if (!field || !Registry.isLattice(field.kind)) throw new Refusal('invalid');
    if (guard.stamp !== null && !Stamp.isValid(guard.stamp)) throw new Refusal('invalid');
  }

  checkCommandShape(cmd) {
    const def = isObject(cmd) ? this.registry.command(cmd.name) : undefined;
    if (!def || def.scope !== this.scopeKind || !isObject(cmd.args)) throw new Refusal('invalid');
    for (const name of Object.keys(cmd.args)) if (!Object.hasOwn(def.args, name)) throw new Refusal('invalid');
    for (const [name, arg] of Object.entries(def.args)) {
      if (!Object.hasOwn(cmd.args, name)) {
        if (arg.optional) continue;
        throw new Refusal('invalid');
      }
      const value = cmd.args[name];
      if (checkArgument(this.registry, arg, value)) throw new Refusal('invalid');
      if (arg.type === 'instant' && value > this.serverNow + this.limits.MAX_SKEW_MS) throw new Refusal('invalid');
    }
  }

  clampTimes(deltas, bound) {
    for (const delta of deltas) {
      const type = this.registry.type(delta.t);
      for (const [name, register] of Object.entries(delta.f ?? {})) {
        if (type.field(name).kind === 'time' && register[0] > bound) delta.f[name] = [this.serverNow, register[1]];
      }
    }
    const cmd = this.intent.cmd;
    if (!cmd) return;
    for (const [name, arg] of Object.entries(this.registry.command(cmd.name).args)) {
      if (arg.type === 'time' && cmd.args[name] > bound) cmd.args[name] = this.serverNow;
    }
  }

  // Step 3: access, the scope a write may create, and the origin rules.
  lockScope() {
    const access = accessOf(this.registry, this.work, this.target, this.origin.account);
    if (!access.write) throw new Refusal(access.refusal);
    if (access.create) {
      const fields = { kind: this.target.kind, owner: this.origin.account };
      if (this.target.kind === 'overlay') fields.governedBy = `tree:${this.target.tree}`;
      this.work.insertScope(this.scopeKey, fields);
    }
    this.scope = this.work.scope(this.scopeKey);
    const originKind = this.fromServer ? 'server' : 'replica';
    for (const delta of this.intent.d ?? []) {
      if (!this.registry.type(delta.t).origins.includes(originKind)) throw new Refusal('forbidden');
    }
    const cmd = this.intent.cmd;
    if (!cmd) return;
    const def = this.registry.command(cmd.name);
    if ((def.serverInternal && !this.fromServer) || !def.origins.includes(originKind)) throw new Refusal('forbidden');
  }

  // §4.2 the id state `lock` and `elsewhere` report (§2.3): a global id no scope holds is `foreign` when
  // the product reports it held outside every scope, as gym's seed exercises are.
  idStateOf(scopeKey, type, id) {
    const state = this.work.idState(this.registry, scopeKey, type, id);
    if (state.state === 'none' && this.product.elsewhere?.(this.work.product, type.type, id)) return { state: 'foreign' };
    return state;
  }

  // What a product's commands and checks read: the origin's kind, the intent's own deltas, the intent
  // scope's rows, and another tree's rows when its scope is readable by the origin (a command that reads
  // another scope, INV-7(e)).
  context() {
    const { work, registry, scopeKey } = this;
    return {
      scopeKey,
      serverNow: this.serverNow,
      account: this.origin.account,
      origin: this.fromServer ? 'server' : 'replica',
      deltas: this.intent.d ?? [],
      guards: this.intent.guard ?? [],
      productState: work.product,
      idState: (t, id) => this.idStateOf(scopeKey, registry.type(t), id),
      stored: (t, id) => work.stored(scopeKey, t, id),
      rowsOf: (t) => work.rowsOf(scopeKey).filter((row) => row.t === t),
      readableTree: (tree) => accessOf(registry, work, { kind: 'tree', key: `tree:${tree}`, tree }, this.origin.account).read === true,
      treeRows: (tree) => work.rowsOf(`tree:${tree}`),
    };
  }

  // Steps 5 and 6 for one group of deltas: the id states, §4.3, and §4.4's const and time rule.
  admitDeltas(deltas, source, scopeKey = this.scopeKey) {
    for (const delta of deltas) {
      const type = this.registry.type(delta.t);
      const op = opOf(type, delta);
      const joined = source === 'check' ? this.records.get(`${scopeKey}|${recordKey(delta.t, delta.id)}`)?.after : undefined;
      const idState = joined ? { state: isAlive(joined) ? 'alive' : 'dead', born: joined.born } : this.idStateOf(scopeKey, type, delta.id);
      const decision = decide(type, op, idState, delta.born);
      if (decision.verdict === 'refuse') throw new Refusal(decision.code);
      if (decision.verdict === 'ok') continue;
      if (source === 'client') this.checkConstAndTime(type, delta);
      this.changes.push({ type, delta: structuredClone(delta), op, idState, source, scopeKey });
    }
  }

  checkConstAndTime(type, delta) {
    const stored = this.work.stored(this.scopeKey, delta.t, delta.id);
    for (const [name, register] of Object.entries(delta.f ?? {})) {
      const kind = type.field(name).kind;
      if (kind !== 'const' && kind !== 'time') continue;
      const current = stored?.f?.[name];
      if (current && current[1] !== register[1] && !sameJson(current[0], register[0])) throw new Refusal('invalid');
    }
  }

  // Step 7. A guard holds on its stamp, on an unset register guarded by null, or when the register
  // already carries the stamp this intent writes to it.
  checkGuards() {
    const cmd = this.intent.cmd;
    if (cmd && this.product.isReplay(this.context(), cmd)) return;
    for (const guard of this.intent.guard ?? []) {
      const current = this.work.stored(this.scopeKey, guard.t, guard.id)?.f?.[guard.field];
      const currentStamp = current ? current[1] : null;
      if (currentStamp === guard.stamp) continue;
      const writes = (this.intent.d ?? []).find((delta) => delta.t === guard.t && sameJson(delta.id, guard.id));
      if (current && writes?.f?.[guard.field]?.[1] === currentStamp) continue;
      throw new Refusal('stale', { t: guard.t, id: guard.id, field: guard.field, current: currentStamp });
    }
  }

  // Step 8. A command's writes into a scope the same intent creates (`into`) wait for step 14.
  runCommand() {
    const cmd = this.intent.cmd;
    if (!cmd) return;
    const outcome = this.product.runCommand(this.context(), cmd);
    this.admitDeltas(outcome.deltas, 'command');
    for (const { scopeKey, deltas } of outcome.into ?? []) this.admitDeltas(deltas, 'command', scopeKey);
    this.write = outcome.write;
    this.detail = outcome.detail;
  }

  // Step 9, one pass: a server stamp for the pass's server deltas (§10.3), then the record joins, text
  // merges and record bound. A dead record of a non-revivable type keeps no fields (G1), so it joins to
  // its stored form.
  join() {
    this.mintServerStamp();
    this.records = new Map();
    for (const change of this.changes) {
      const key = `${change.scopeKey}|${recordKey(change.delta.t, change.delta.id)}`;
      const known = this.records.get(key);
      const before = known ? known.after : this.work.stored(change.scopeKey, change.delta.t, change.delta.id);
      const after = { t: change.delta.t, id: change.delta.id, ...joinRecord(change.type, before ? latticeOf(before) : {}, latticeOf(change.delta)) };
      if (before?.x) after.x = structuredClone(before.x);
      if (before?.v || change.delta.v) after.v = { ...(before?.v ?? {}), ...(change.delta.v ?? {}) };
      const { texts, revisions } = this.mergeTexts(change, before);
      if (Object.keys(texts).length) after.x = { ...(after.x ?? {}), ...texts };
      const joinedFields = after.f;
      if (!isAlive(after) && !change.type.revivable) for (const part of ['f', 'x', 'v']) delete after[part];
      const typedBefore = known ? known.typedBefore : this.work.row(change.scopeKey, change.delta.t, change.delta.id);
      const original = known ? known.original : before;
      const changes = !sameJson(comparable(original), comparable(after));
      if (changes && this.storedBytes(change.scopeKey, after, typedBefore) > this.limits.MAX_RECORD_BYTES) throw new Refusal('too-large');
      this.records.set(key, {
        scopeKey: change.scopeKey,
        type: change.type,
        delta: change.delta,
        createdBy: [...(known?.createdBy ?? []), ...(change.op === 'create' ? [change.source] : [])],
        original,
        typedBefore,
        joinedFields,
        isNew: known ? known.isNew : change.idState.state === 'none' || change.idState.state === 'foreign',
        after,
        revisions: [...(known?.revisions ?? []), ...revisions],
      });
    }
  }

  // The joined row's encoding as step 13 would store it: at the next seq, with rc, ru and new text revs,
  // and without the serial step 11 has yet to assign. Only a row the intent changes is measured.
  storedBytes(scopeKey, after, typedBefore) {
    const seq = (this.work.scope(scopeKey)?.seq ?? 0) + 1;
    const x = after.x && Object.fromEntries(Object.entries(after.x).map(([name, text]) => [name, { ...text, rev: text.rev ?? seq }]));
    const row = compactRow({ ...after, x, seq, rc: typedBefore ? typedBefore.rc : this.serverNow, ru: this.serverNow });
    return Buffer.byteLength(jcs(row), 'utf8');
  }

  // §10.3 for one pass of step 9: the clock observes every register the pass's unstamped server deltas
  // write, as stored and as a same-intent client delta writes it, then ticks once; the stamp fills their
  // nulls. The first pass also fills the write map, so a delta step 10 appends is stamped in a later
  // pass, after observing every stamp it could lose to.
  mintServerStamp() {
    const serverChanges = this.changes.filter((change) => change.source !== 'client' && stampsOf(change.delta).includes(null));
    const mapNeeds = !this.mapStamped && (this.write ?? []).some((entry) => entry.born === null || Object.values(entry.f ?? {}).includes(null));
    if (serverChanges.length === 0 && !mapNeeds) return;
    const clock = new Clock(this.work.clock, 'srv', () => this.serverNow);
    for (const change of serverChanges) {
      const { t, id, life, f } = change.delta;
      const others = [this.work.stored(change.scopeKey, t, id), ...this.changes
        .filter((other) => other.source === 'client' && other.scopeKey === change.scopeKey && other.delta.t === t && sameJson(other.delta.id, id))
        .map((other) => other.delta)];
      for (const other of others) {
        if (life && other?.life) clock.observe(other.life[1]);
        for (const name of Object.keys(f ?? {})) if (other?.f?.[name]) clock.observe(other.f[name][1]);
      }
    }
    const stamp = clock.tick();
    this.work.clock = clock.pair;
    for (const { delta } of serverChanges) {
      if (delta.life?.[1] === null) delta.life = [delta.life[0], stamp];
      if (delta.born === null) delta.born = stamp;
      for (const [name, register] of Object.entries(delta.f ?? {})) if (register[1] === null) delta.f[name] = [register[0], stamp];
    }
    if (this.mapStamped) return;
    this.mapStamped = true;
    for (const entry of this.write ?? []) {
      if (entry.born === null) entry.born = stamp;
      for (const name of Object.keys(entry.f ?? {})) if (entry.f[name] === null) entry.f[name] = stamp;
    }
  }

  // Step 10: the product's rules on the joined records; the server deltas they append pass steps 5, 6
  // and 9 (a second pass, with its own stamp).
  checkProduct() {
    const appended = this.product.check(this.context(), [...this.records.values()]);
    if (appended.length === 0) return;
    this.admitDeltas(appended, 'check');
    this.join();
  }

  mergeTexts(change, before) {
    const texts = {};
    const revisions = [];
    for (const [name, write] of Object.entries(change.delta.x ?? {})) {
      const field = change.type.field(name);
      const stored = before?.x?.[name] ?? { text: '', rev: 0, merged: false };
      if (write.replace === true && change.source === 'command') {
        if (lengthIn(field.unit, write.text) > field.max) throw new Refusal('too-large');
        texts[name] = { text: write.text, rev: null, merged: false };
        if (stored.rev > 0 && (!write.archiveNonempty || stored.text !== '')) {
          revisions.push({ ...write.archive, t: change.delta.t, id: change.delta.id, field: name, rev: stored.rev, text: stored.text });
        }
        continue;
      }
      const merge = mergeText({
        stored,
        base: write.base,
        mine: write.text,
        revisionText: (rev) => this.work.revisionsOf(change.scopeKey, change.delta.t, change.delta.id, name).find((r) => r.rev === rev)?.text,
        limits: this.limits,
      });
      if (merge.refuse) throw new Refusal(merge.refuse);
      if (lengthIn(field.unit, merge.text) > field.max) throw new Refusal('too-large');
      const merged = mergedFlag(stored, merge);
      if (merge.text === stored.text && merged === stored.merged) continue;
      texts[name] = { text: merge.text, rev: null, merged };
      if (stored.rev > 0) revisions.push({ t: change.delta.t, id: change.delta.id, field: name, rev: stored.rev, text: stored.text });
    }
    return { texts, revisions };
  }

  // Step 10's parent rule, over the joined records: a create or update whose parent is not alive; a
  // parent created in the same intent counts. The reference is read as the join wrote it, before G1
  // drops a dead record's fields.
  checkParents() {
    for (const change of this.changes) {
      if (change.op !== 'create' && change.op !== 'update') continue;
      const name = change.type.parentField;
      if (!name) continue;
      const record = this.records.get(`${change.scopeKey}|${recordKey(change.delta.t, change.delta.id)}`).after;
      const ref = change.type.field(name).ref;
      const parentId = this.records.get(`${change.scopeKey}|${recordKey(change.delta.t, change.delta.id)}`).joinedFields?.[name]?.[0];
      const parent = this.records.get(`${change.scopeKey}|${recordKey(ref, parentId)}`)?.after ?? this.work.stored(change.scopeKey, ref, parentId);
      if (!parent || !isAlive(parent)) throw new Refusal('parent-dead');
    }
  }

  // Step 11: a new alive record's serial field numbers 1 + the maximum over alive records sharing its
  // serialNext values, in admission order; a value the command supplies is kept.
  assignSerials() {
    const numbered = [];
    for (const record of this.records.values()) {
      if (!record.isNew || !isAlive(record.after)) continue;
      const { after, type } = record;
      for (const name of type.serialFieldNames) {
        if (after.v?.[name] !== undefined) continue;
        const next = type.field(name).serialNext;
        const peers = [...this.work.rowsOf(record.scopeKey), ...numbered]
          .filter((row) => row.t === after.t && isAlive(row) && !sameJson(row.id, after.id))
          .filter((row) => next.every((field) => sameJson(row.f?.[field]?.[0], after.f?.[field]?.[0])));
        after.v = { ...(after.v ?? {}), [name]: 1 + Math.max(0, ...peers.map((row) => row.v?.[name] ?? 0)) };
      }
      numbered.push(after);
    }
  }

  // Step 12: the growth rule, per scope, on the capped types.
  checkCaps() {
    this.counts = {};
    for (const record of this.records.values()) {
      const { type, scopeKey } = record;
      if (type.cap === undefined) continue;
      const counts = (this.counts[scopeKey] ??= {});
      counts[type.type] ??= this.work.scope(scopeKey)?.counters[type.type] ?? 0;
      counts[type.type] += (isAlive(record.after) ? 1 : 0) - (record.original && isAlive(record.original) ? 1 : 0);
    }
    for (const [scopeKey, counts] of Object.entries(this.counts)) {
      for (const [t, after] of Object.entries(counts)) {
        const { cap } = this.registry.type(t);
        const before = this.work.scope(scopeKey)?.counters[t] ?? 0;
        if (after > cap && after > before) throw new Refusal('cap', { type: t, cap });
      }
    }
  }

  // Step 13 for one scope: seq, counters, typed rows, spent ids, text revisions, rc/ru and the digest.
  apply(scopeKey) {
    const changed = [...this.records.values()]
      .filter((record) => record.scopeKey === scopeKey && !sameJson(comparable(record.original), comparable(record.after)));
    this.changed.push(...changed);
    if (changed.length === 0) return;
    const scope = this.work.scope(scopeKey);
    const seq = ++scope.seq;
    Object.assign(scope.counters, this.counts[scopeKey] ?? {});
    const rows = [];
    for (const record of changed) {
      const { type, typedBefore, after } = record;
      for (const name of Object.keys(after.x ?? {})) if (after.x[name].rev === null) after.x[name].rev = seq;
      for (const revision of record.revisions) this.work.keepRevision(scopeKey, revision, this.product.revisionsKept);
      const stamped = { ...after, seq, rc: typedBefore ? typedBefore.rc : this.serverNow, ru: this.serverNow };
      const dead = !isAlive(after);
      let typedAfter;
      if (dead && !type.revivable && type.deadRows === 'spent') {
        this.work.deleteRow(scopeKey, after.t, after.id);
        const spent = { t: after.t, id: after.id, lifeStamp: after.life[1], seq };
        if (after.born !== undefined) spent.born = after.born;
        this.work.putSpent(scopeKey, spent);
        rows.push(thinRow(stamped));
      } else {
        typedAfter = compactRow(stamped);
        this.work.putRow(scopeKey, typedAfter);
        this.work.deleteSpent(scopeKey, after.t, after.id);
        rows.push(dead ? thinRow(typedAfter) : typedAfter);
      }
      scope.digest = replaceRow(scope.digest, typedBefore, typedAfter);
    }
    this.writes.push({ key: scopeKey, rows });
    if (this.product.pruneRevisions && changed.some((record) => record.revisions.length > 0)) {
      this.work.revisions[scopeKey] = this.product.pruneRevisions({
        ...this.context(), scopeKey, revisions: this.work.revisions[scopeKey] ?? [],
        archived: changed.flatMap((record) => record.revisions),
      });
    }
  }

  // Step 14: a command's writes into scopes this intent created, each at that scope's seq and digest.
  applyCreatedScopes() {
    const targets = [...new Set(this.changes.map((change) => change.scopeKey).filter((key) => key !== this.scopeKey))].sort();
    for (const key of targets) {
      if (!this.created.includes(key)) throw new Error(`a command wrote into ${key}, which this intent did not create`);
      this.apply(key);
    }
  }

  // Step 15: a governing record's create inserts its scope; its death kills the scope and its overlays.
  applyLifecycle() {
    this.created = [];
    for (const record of this.changed) {
      if (record.type.governs !== 'tree') continue;
      const treeKey = `tree:${record.after.id}`;
      const wasAlive = record.original !== undefined && isAlive(record.original);
      if (isAlive(record.after) && !wasAlive && this.work.scope(treeKey) === undefined) {
        this.work.insertScope(treeKey, { kind: 'tree', owner: this.origin.account, governedBy: `${this.scopeKey}#${record.type.type}#${record.after.id}` });
        this.created.push(treeKey);
      }
      if (!isAlive(record.after) && wasAlive) {
        for (const key of Object.keys(this.work.scopes).sort()) {
          const scope = this.work.scopes[key];
          if (key !== treeKey && scope.governedBy !== treeKey) continue;
          Object.assign(scope, { state: 'dead', deadAt: this.serverNow });
          this.killed.push(key);
        }
      }
    }
  }

  // Step 16.
  result() {
    const result = { s: 'ok', seq: this.scope.seq };
    if (this.write !== undefined) result.write = this.write;
    if (this.detail !== undefined) result.detail = this.detail;
    return result;
  }
}

function comparable(record) {
  if (!record) return null;
  const out = latticeOf(record);
  if (record.x) out.x = Object.fromEntries(Object.entries(record.x).map(([name, text]) => [name, { text: text.text, merged: text.merged }]));
  if (record.v) out.v = record.v;
  return out;
}
