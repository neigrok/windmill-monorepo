// §7.7 refusal, recovery and write maps. The restamp rule is one primitive, `moveRegister`; what moves
// with a register (borns, carried lives, guards) reaches later sent entries too, which recover alike.

import { Clock, maxPair } from '../core/clock.js';
import { sameJson } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { recordKey } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { baseTextKey } from './commit.js';

function isQueued(entry) {
  return entry.state === 'held' || entry.state === 'ready';
}

function deltasOf(entry) {
  return [...(entry.intent.d ?? []), ...(entry.predict ?? [])];
}

function laterUnacked(replica, entry) {
  return replica.entries().filter((other) => other.commitOrder > entry.commitOrder && (isQueued(other) || other.state === 'sent'));
}

// `register`: 'life' or a field name. A create's born moves with its life; a later delta carrying the
// life register unchanged (a keyed put that keeps presence, §7.1 step 4) follows it.
function moveRegister(replica, entry, delta, register, n) {
  const current = register === 'life' ? delta.life : delta.f?.[register];
  if (!current || current[1] === n) return;
  const o = current[1];
  if (register === 'life') {
    const createsRecord = delta.life[0] === 'alive' && delta.born === o;
    delta.life = [delta.life[0], n];
    if (createsRecord) delta.born = n;
    for (const later of laterUnacked(replica, entry)) {
      for (const other of deltasOf(later)) {
        if (other.t !== delta.t || !sameJson(other.id, delta.id)) continue;
        if (createsRecord && other.born === o) other.born = n;
        if (other.life?.[1] === o) other.life = [other.life[0], n];
      }
    }
    return;
  }
  delta.f[register] = [delta.f[register][0], n];
  for (const later of laterUnacked(replica, entry)) {
    for (const guard of later.intent.guard ?? []) {
      if (guard.t === delta.t && sameJson(guard.id, delta.id) && guard.field === register && guard.stamp === o) guard.stamp = n;
    }
  }
}

// The registers an entry's intent itself writes: those stamped at or after its gesture stamp. A life
// register a keyed put carries unchanged from drawn is older, and only follows its source.
function ownRegisters(entry) {
  const own = [];
  for (const delta of entry.intent.d ?? []) {
    const registers = [...(delta.life ? [['life', delta.life[1]]] : []), ...Object.entries(delta.f ?? {}).map(([name, register]) => [name, register[1]])];
    for (const [register, stamp] of registers) if (Stamp.compare(stamp, entry.stamp) >= 0) own.push([delta, register]);
  }
  return own;
}

// A fresh tick from the shared clock, in the actor of the instance that authored the entry (§7.2's
// same-actor text rule keeps meaning one engine instance).
function authoredTick(clock, entry) {
  const { ms, counter } = Stamp.parse(clock.tick());
  return Stamp.encode({ ms, counter, actor: Stamp.parse(entry.stamp).actor });
}

// §7.7 step 1 for clock-skew. The caller has already taken the response's offset sample.
function recoverSkew(replica, ctx, refused, lastN) {
  const { meta } = replica;
  const physNow = ctx.deviceNow + meta.serverOffsetMs;
  meta.hlc = maxPair({ ms: physNow, counter: 0 }, Stamp.pairOf(meta.admittedHigh));
  for (const entry of replica.entries()) {
    if (entry !== refused && entry.state === 'sent' && entry.n > lastN) moveEntry(replica, ctx.ended, entry, 'skew-return');
  }
  meta.nextN = lastN + 1;
  moveEntry(replica, ctx.ended, refused, 'recover');
  const clock = new Clock(meta.hlc, ctx.actor, () => physNow);
  let high = meta.admittedHigh;
  const plan = replica.entries().filter(isQueued).map((entry) => ({ entry, own: ownRegisters(entry) }));
  for (const { entry, own } of plan) {
    const n = authoredTick(clock, entry);
    for (const [delta, register] of own) moveRegister(replica, entry, delta, register, n);
    entry.stamp = n;
    high = Stamp.max(high, n);
  }
  meta.hlc = Stamp.pairOf(high);
  meta.hlcHigh = high;
}

function recoverBase(replica, ctx, refused) {
  for (const delta of refused.intent.d ?? []) {
    for (const [name, write] of Object.entries(delta.x ?? {})) {
      write.base = { text: refused.baseTexts[baseTextKey(delta.t, delta.id, name)] };
    }
  }
  moveEntry(replica, ctx.ended, refused, 'recover');
}

// A record is (scope, t, id): a ref names a record in the scope its type lives in, relative to the
// referencing scope's tree.
function scopedKey(scope, t, id) {
  return `${scope}|${recordKey(t, id)}`;
}

function scopeOfType(registry, fromScope, t) {
  const kind = registry.type(t)?.scope;
  if (kind?.startsWith('product:')) return `self/${kind.slice('product:'.length)}`;
  const tree = fromScope.split('/').pop();
  return kind === 'tree' ? `tree/${tree}` : `self/overlay/${tree}`;
}

function createdBy(registry, scope, deltas) {
  const created = new Set();
  const governed = new Set();
  for (const delta of deltas) {
    if (delta.life?.[0] !== 'alive' || delta.born === undefined || delta.life[1] !== delta.born) continue;
    created.add(scopedKey(scope, delta.t, delta.id));
    if (registry.type(delta.t)?.governs === 'tree') {
      governed.add(`tree/${delta.id}`);
      governed.add(`self/overlay/${delta.id}`);
    }
  }
  return { created, governed };
}

function refsOf(registry, delta) {
  const values = Object.fromEntries(Object.entries(delta.f ?? {}).map(([name, register]) => [name, register[0]]));
  return registry.type(delta.t).referencesOf(delta.id, values);
}

function commandRefs(registry, cmd) {
  const def = registry.command(cmd.name);
  const refs = [];
  for (const [name, arg] of Object.entries(def?.args ?? {})) {
    const t = /^ref<(.+)>$/.exec(arg.type)?.[1];
    if (t && typeof cmd.args[name] === 'string') refs.push({ t, id: cmd.args[name], name });
  }
  return refs;
}

// §7.7 step 3: later deltas and commands that touch or name a record `refused` created, or target a
// scope its governing record creates, transitively. A queued dependent is removed into the notice; a
// sent entry that is wholly dependent is an orphan, in the notice; a partly dependent one stays.
function foldDependents(replica, ctx, refused) {
  const { registry } = ctx;
  const { created, governed } = createdBy(registry, refused.scope, deltasOf(refused));
  const names = (scope, t, id) => created.has(scopedKey(scopeOfType(registry, scope, t), t, id));
  const dependsOn = (entry, delta) => governed.has(entry.scope)
    || created.has(scopedKey(entry.scope, delta.t, delta.id))
    || refsOf(registry, delta).some((ref) => names(entry.scope, ref.t, ref.id));
  const commandDepends = (entry) => entry.intent.cmd !== undefined
    && (governed.has(entry.scope) || commandRefs(registry, entry.intent.cmd).some((ref) => names(entry.scope, ref.t, ref.id)));
  const absorb = (scope, deltas) => {
    const next = createdBy(registry, scope, deltas);
    for (const key of next.created) created.add(key);
    for (const tree of next.governed) governed.add(tree);
  };
  const folded = [];
  for (const entry of replica.entries().filter((other) => other.commitOrder > refused.commitOrder)) {
    const removed = (entry.intent.d ?? []).filter((delta) => dependsOn(entry, delta));
    const cmdGone = commandDepends(entry);
    if (removed.length === 0 && !cmdGone) continue;
    if (entry.state === 'sent') {
      const whole = removed.length === (entry.intent.d ?? []).length && (entry.intent.cmd === undefined || cmdGone);
      if (!whole) continue;
      absorb(entry.scope, deltasOf(entry));
      folded.push(contentOf(entry));
      entry.orphanOf = refused.localId;
      continue;
    }
    if (!isQueued(entry)) continue;
    absorb(entry.scope, [...removed, ...(cmdGone ? entry.predict ?? [] : [])]);
    const content = {};
    if (removed.length) content.d = removed;
    if (cmdGone) content.cmd = entry.intent.cmd;
    folded.push(content);
    const kept = (entry.intent.d ?? []).filter((delta) => !removed.includes(delta));
    const removedKeys = new Set(removed.map((delta) => recordKey(delta.t, delta.id)));
    if (kept.length) entry.intent.d = kept;
    else delete entry.intent.d;
    if (entry.intent.guard) {
      entry.intent.guard = entry.intent.guard.filter((guard) => !removedKeys.has(recordKey(guard.t, guard.id)));
      if (entry.intent.guard.length === 0) delete entry.intent.guard;
    }
    if (cmdGone) {
      delete entry.intent.cmd;
      delete entry.predict;
    }
    if (entry.intent.d === undefined && entry.intent.cmd === undefined) {
      entry.orphanOf = refused.localId;
      moveEntry(replica, ctx.ended, entry, 'fold');
    }
  }
  return folded;
}

function contentOf(entry) {
  const content = {};
  if (entry.intent.d?.length) content.d = entry.intent.d;
  if (entry.intent.cmd) content.cmd = entry.intent.cmd;
  return content;
}

// A refusal of a sent entry: automatic recovery, or removal, folding and a notice (§7.7 steps 1-5).
export function onRefused(replica, ctx, entry, result, response) {
  if (entry.orphanOf !== undefined) {
    moveEntry(replica, ctx.ended, entry, 'refuse');
    return;
  }
  if (result.code === 'clock-skew') return recoverSkew(replica, ctx, entry, response.lastN);
  if (result.code === 'base-unknown') return recoverBase(replica, ctx, entry);
  moveEntry(replica, ctx.ended, entry, 'refuse');
  const dependents = foldDependents(replica, ctx, entry);
  const notice = { id: `notice:${entry.localId}`, scope: entry.scope, code: result.code, content: contentOf(entry), at: ctx.deviceNow };
  if (result.detail !== undefined) notice.detail = result.detail;
  if (dependents.length) notice.content.dependents = dependents;
  replica.notices.push(notice);
}

function rewriteId(registry, delta, w) {
  if (delta.t === w.t && sameJson(delta.id, w.from)) delta.id = w.id;
  const type = registry.type(delta.t);
  if (type.key?.ref === w.t && sameJson(delta.id, w.from)) delta.id = w.id;
  if (type.key?.tuple) delta.id = delta.id.map((part, index) => (type.key.tuple[index].ref === w.t && part === w.from ? w.id : part));
  for (const [name, register] of Object.entries(delta.f ?? {})) {
    if (type.field(name)?.ref === w.t && register[0] === w.from) delta.f[name] = [w.id, register[1]];
  }
}

function rewriteEntry(registry, entry, w) {
  for (const delta of deltasOf(entry)) rewriteId(registry, delta, w);
  for (const guard of entry.intent.guard ?? []) if (guard.t === w.t && sameJson(guard.id, w.from)) guard.id = w.id;
  if (entry.intent.cmd) {
    for (const ref of commandRefs(registry, entry.intent.cmd)) if (ref.t === w.t && ref.id === w.from) entry.intent.cmd.args[ref.name] = w.id;
  }
}

// §7.7 write map: an ok result's map applies in the result's transaction.
export function applyWriteMap(replica, ctx, command, write) {
  const { registry } = ctx;
  for (const w of write) {
    if (w.from !== undefined) {
      for (const entry of replica.entries().filter(isQueued)) {
        const deletesTarget = (entry.intent.d ?? []).some((delta) => delta.t === w.t && sameJson(delta.id, w.from) && delta.life?.[0] === 'dead');
        if (deletesTarget) {
          replica.notices.push({ id: `notice:${entry.localId}`, scope: entry.scope, code: 'target-merged', content: contentOf(entry), at: ctx.deviceNow });
          moveEntry(replica, ctx.ended, entry, 'target-merged');
          continue;
        }
        rewriteEntry(registry, entry, w);
      }
      for (const delta of command.predict ?? []) rewriteId(registry, delta, w);
    }
    for (const delta of command.predict ?? []) {
      if (delta.t !== w.t || !sameJson(delta.id, w.id)) continue;
      for (const [name, stamp] of Object.entries(w.f ?? {})) moveRegister(replica, command, delta, name, stamp);
      if (w.born !== undefined) moveRegister(replica, command, delta, 'life', w.born);
    }
  }

  const mapped = write.flatMap((w) => [...(w.born !== undefined ? [w.born] : []), ...Object.values(w.f ?? {})]);
  replica.observe(mapped);
  replica.raiseAdmittedHigh(mapped);
  const physNow = ctx.deviceNow + replica.meta.serverOffsetMs;
  const clock = new Clock(replica.meta.hlc, ctx.actor, () => physNow);
  for (const entry of replica.entries().filter(isQueued)) {
    const named = [];
    for (const delta of deltasOf(entry)) {
      for (const w of write) {
        if (delta.t !== w.t || !sameJson(delta.id, w.id)) continue;
        for (const name of Object.keys(w.f ?? {})) if (delta.f?.[name]) named.push([delta, name]);
        if (w.born !== undefined && delta.life) named.push([delta, 'life']);
      }
    }
    if (named.length === 0) continue;
    const n = authoredTick(clock, entry);
    for (const [delta, register] of named) moveRegister(replica, entry, delta, register, n);
    replica.meta.hlcHigh = Stamp.max(replica.meta.hlcHigh, n);
  }
  replica.meta.hlc = clock.pair;
}
