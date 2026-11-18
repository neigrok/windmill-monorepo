// §7.7 refusal, recovery and write maps. The restamp rule is one primitive, `moveRegister`; what moves
// with a register (borns, carried lives, guards) reaches later sent entries too, which recover alike.
// Clock-skew recovery also lowers the stamps no unacked entry is the source of (step 1.5).

import { Clock, maxPair } from '../core/clock.js';
import { sameJson } from '../core/jcs.js';
import { moveEntry } from '../core/machines.js';
import { Stamp } from '../core/stamp.js';
import { remappedScope } from '../core/receipts.js';
import { baseTextKey } from './commit.js';
import { Dependents, commandRefs, deltasOf, isEmpty, removeDependent } from './dependents.js';
import { effectsOf, mergePredictions, predictionsOf } from './projections.js';

function isQueued(entry) {
  return entry.state === 'held' || entry.state === 'ready';
}

function laterUnacked(replica, entry) {
  return replica.entries().filter((other) => other.commitOrder > entry.commitOrder && (isQueued(other) || other.state === 'sent'));
}

// `register`: 'life' or a field name of `delta`, which writes `scope`: an opted entry's projection is its own
// scope's. A create's born moves with its life; a later delta carrying the life register unchanged (a keyed put
// that keeps presence, §7.1 step 4) follows it.
function moveRegister(replica, entry, scope, delta, register, n, queuedOnly = false) {
  const current = register === 'life' ? delta.life : delta.f?.[register];
  if (!current || current[1] === n) return;
  const o = current[1];
  const createsRecord = register === 'life' && delta.life[0] === 'alive' && delta.born === o;
  if (register === 'life') delta.life = [delta.life[0], n];
  else delta.f[register] = [delta.f[register][0], n];
  if (createsRecord) delta.born = n;
  followRegister(replica, entry, scope, delta, register, o, n, { createsRecord, queuedOnly: queuedOnly || entry.predictions !== undefined });
}

// What follows a record's register from stamp `o` to `n` in the entries after `entry`, in `scope`: the
// borns of a record it creates and the lives that carry it, or the guards on a field.
function followRegister(replica, entry, scope, record, register, o, n, { createsRecord = false, queuedOnly = false } = {}) {
  const sameRecord = (other) => other.t === record.t && sameJson(other.id, record.id);
  for (const later of laterUnacked(replica, entry)) {
    if (queuedOnly && !isQueued(later)) continue;
    if (register === 'life') {
      for (const other of effectsOf(later).filter((effect) => effect.scope === scope).flatMap(({ d }) => d).filter(sameRecord)) {
        if (createsRecord && other.born === o) other.born = n;
        if (other.life?.[1] === o) other.life = [other.life[0], n];
      }
    } else if (later.scope === scope) {
      for (const guard of later.intent.guard ?? []) if (sameRecord(guard) && guard.field === register && guard.stamp === o) guard.stamp = n;
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

const lifeKey = (scope, t, id, stamp) => `${scope}|${t}|${JSON.stringify(id)}|${stamp}`;

// The borns and carried life registers of queued entries above admittedHigh whose source no unacked
// entry holds: no held, ready or sent entry wrote that life register, by a delta or a prediction. Such a
// stamp is a prediction whose command's `ok` gave it no stamp (§7.7 write map): no server checked it.
function unsourced(replica) {
  const unadmitted = (stamp) => Stamp.less(replica.meta.admittedHigh, stamp);
  const written = new Set();
  for (const entry of replica.entries().filter((other) => isQueued(other) || other.state === 'sent')) {
    for (const [delta, register] of ownRegisters(entry)) if (register === 'life') written.add(lifeKey(entry.scope, delta.t, delta.id, delta.life[1]));
    for (const { scope, d } of predictionsOf(entry)) for (const delta of d) if (delta.life) written.add(lifeKey(scope, delta.t, delta.id, delta.life[1]));
  }
  const carried = [];
  for (const entry of replica.entries().filter(isQueued)) {
    for (const delta of entry.intent.d ?? []) {
      const creates = delta.life?.[0] === 'alive' && delta.life[1] === delta.born;
      if (delta.born !== undefined && !creates && unadmitted(delta.born) && !written.has(lifeKey(entry.scope, delta.t, delta.id, delta.born))) carried.push({ delta, key: 'born' });
      if (delta.life && Stamp.less(delta.life[1], entry.stamp) && unadmitted(delta.life[1]) && !written.has(lifeKey(entry.scope, delta.t, delta.id, delta.life[1]))) {
        carried.push({ delta, key: 'life' });
      }
    }
  }
  return carried;
}

// §7.7 step 1 for clock-skew. The caller has already taken the response's offset sample.
function recoverSkew(replica, ctx, refused, lastN) {
  const { meta } = replica;
  const physNow = ctx.deviceNow + meta.serverOffsetMs;
  meta.hlc = maxPair({ ms: physNow, counter: 0 }, Stamp.pairOf(meta.admittedHigh));
  const floor = Stamp.encode({ ...meta.hlc, actor: ctx.actor });
  for (const entry of replica.entries()) {
    if (entry !== refused && entry.state === 'sent' && entry.n > lastN) moveEntry(replica, ctx.ended, entry, 'skew-return');
  }
  meta.nextN = lastN + 1;
  moveEntry(replica, ctx.ended, refused, 'recover');
  const clock = new Clock(meta.hlc, ctx.actor, () => physNow);
  let high = meta.admittedHigh;
  const plan = replica.entries().filter(isQueued).map((entry) => ({ entry, own: ownRegisters(entry) }));
  const lowered = unsourced(replica);
  for (const { entry, own } of plan) {
    const n = clock.tick();
    for (const [delta, register] of own) moveRegister(replica, entry, entry.scope, delta, register, n);
    entry.stamp = n;
    high = Stamp.max(high, n);
  }
  // Step 1.5: each takes the lesser of its stamp and the recovered clock's reading, which passes.
  for (const { delta, key } of lowered) {
    if (key === 'born') delta.born = Stamp.min(delta.born, floor);
    else delta.life = [delta.life[0], Stamp.min(delta.life[1], floor)];
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

// §7.7 step 3: the dependents of a refused `source` fold into the notice of `origin`, the refused entry
// itself or the one whose notice an orphan's content rides. A queued dependent part is removed; a
// sent entry with any dependent part is an orphan, whole in the notice. An orphan is no source here:
// its own dependents are held back (§7.4) until its result, and fold only when it is refused.
function foldDependents(replica, ctx, source, origin) {
  const dependents = new Dependents(ctx.registry);
  dependents.absorbEntry(source);
  const folded = [];
  for (const entry of replica.entries().filter((other) => other.commitOrder > source.commitOrder)) {
    const part = dependents.of(entry);
    if (!part.any) continue;
    if (entry.state === 'sent') {
      folded.push({ ...contentOf(entry), ...(source.predictions || entry.predictions ? { scope: entry.scope } : {}) });
      entry.orphanOf = origin;
      continue;
    }
    if (!isQueued(entry)) continue;
    dependents.absorbPart(entry, part);
    const scoped = source.predictions || entry.predictions;
    folded.push({ ...removeDependent(entry, part), ...(scoped ? { scope: entry.scope } : {}) });
    if (isEmpty(entry)) {
      entry.orphanOf = origin;
      moveEntry(replica, ctx.ended, entry, 'fold');
    }
  }
  return folded;
}

// An entry's content as a notice keeps it: a snapshot, which no later recovery, restamp or write map
// changes (§7.7 step 4).
function contentOf(entry) {
  const content = {};
  if (entry.intent.d?.length) content.d = structuredClone(entry.intent.d);
  if (entry.intent.cmd) content.cmd = structuredClone(entry.intent.cmd);
  if (entry.predictions) content.predictions = structuredClone(entry.predictions);
  return content;
}

// §7.7 steps 2-4 for an entry refused by `event`: remove it, fold its dependents, and write its notice.
function refuse(replica, ctx, entry, event, { code, detail }) {
  moveEntry(replica, ctx.ended, entry, event);
  const dependents = foldDependents(replica, ctx, entry, entry.localId);
  const notice = { id: `notice:${entry.localId}`, scope: entry.scope, code, content: contentOf(entry), at: ctx.deviceNow };
  if (detail !== undefined) notice.detail = detail;
  if (dependents.length) notice.content.dependents = dependents;
  replica.notices.push(notice);
}

// An orphan's refusal, by the server or as outgrown, ends it with no notice of its own; its held-back
// dependents fold into the origin's notice, its whole content their source, and show that notice again
// if it was dismissed.
function refuseOrphan(replica, ctx, orphan, event = 'refuse') {
  moveEntry(replica, ctx.ended, orphan, event);
  const dependents = foldDependents(replica, ctx, orphan, orphan.orphanOf);
  if (dependents.length === 0) return;
  const notice = replica.notices.find((candidate) => candidate.id === `notice:${orphan.orphanOf}`);
  if (!notice) throw new Error(`notice:${orphan.orphanOf}, which ${orphan.localId}'s orphanOf names, is gone (D-17 keeps it)`);
  notice.content.dependents = [...(notice.content.dependents ?? []), ...dependents];
  delete notice.dismissed;
}

// D-17: a product dismisses a notice, which hides it until content folds into it.
export function dismiss(replica, noticeId) {
  const notice = replica.notices.find((candidate) => candidate.id === noticeId);
  if (!notice) throw new Error(`${noticeId} is not a notice of ${replica.id}`);
  notice.dismissed = true;
}

// Observed-scope copy only; the durable notice retains its origin and complete content for discard/copy.
export function noticesInScope(replica, scope) {
  const project = (content, origin) => {
    const here = content.scope ?? origin;
    const d = [...(here === scope ? content.d ?? [] : []), ...(content.predictions ?? []).filter((item) => item.scope === scope).flatMap(({ d }) => d)];
    const dependents = (content.dependents ?? []).map((child) => project(child, here)).filter(Boolean);
    if (here !== scope && d.length === 0 && dependents.length === 0) return null;
    const out = {};
    if (d.length) out.d = structuredClone(d);
    // Command argument references belong to the origin, never a target's repeated singleton id.
    if (here === scope && content.cmd) out.cmd = structuredClone(content.cmd);
    if (dependents.length) out.dependents = dependents;
    return out;
  };
  return replica.notices.flatMap((notice) => {
    const scoped = notice.content.predictions || notice.content.dependents?.some((content) => content.scope || content.predictions);
    if (!scoped) return notice.scope === scope ? [notice] : [];
    const content = project(notice.content, notice.scope);
    return content ? [{ ...notice, content }] : [];
  });
}

// §7.4: a ready entry that grew after commit past a request alone ends too-large before it is numbered,
// with its notice, or, an orphan, with none of its own, as a one-intent 413 would end it.
export function refuseOutgrown(replica, ctx, entry) {
  if (entry.orphanOf !== undefined) return refuseOrphan(replica, ctx, entry, 'outgrown');
  return refuse(replica, ctx, entry, 'outgrown', { code: 'too-large' });
}

// A refusal of a sent entry: automatic recovery, or removal, folding and a notice (§7.7 steps 1-5).
export function onRefused(replica, ctx, entry, result, response) {
  if (entry.orphanOf !== undefined) return refuseOrphan(replica, ctx, entry);
  if (result.code === 'clock-skew') return recoverSkew(replica, ctx, entry, response.lastN);
  if (result.code === 'base-unknown') return recoverBase(replica, ctx, entry);
  refuse(replica, ctx, entry, 'refuse', result);
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

function rewriteEntry(registry, entry, w, { replay = false, scope = entry.scope, predictionOnly = false } = {}) {
  const global = registry.type(w.t)?.idSpace === 'global';
  const origin = global || entry.scope === scope;
  if (!predictionOnly && origin && replay && entry.intent.cmd) {
    for (const target of entry.writeTargets ?? []) {
      if (target.t !== w.t || !sameJson(target.id, w.from)) continue;
      const refs = commandRefs(registry, entry.intent.cmd).filter((ref) => ref.t === w.t && sameJson(ref.id, target.from));
      for (const ref of refs) entry.intent.cmd.args[ref.name] = w.id;
      if (refs.length) target.from = w.id;
    }
  }
  for (const group of predictionOnly ? predictionsOf(entry) : effectsOf(entry)) {
    if (global || group.scope === scope) for (const delta of group.d) rewriteId(registry, delta, w);
  }
  if (!predictionOnly && origin) {
    for (const guard of entry.intent.guard ?? []) if (guard.t === w.t && sameJson(guard.id, w.from)) guard.id = w.id;
    for (const ref of entry.intent.cmd ? commandRefs(registry, entry.intent.cmd) : []) {
      if (ref.t === w.t && sameJson(ref.id, w.from)) entry.intent.cmd.args[ref.name] = w.id;
    }
    for (const target of entry.writeTargets ?? []) {
      if (target.t !== w.t) continue;
      if (sameJson(target.from, w.from)) target.from = w.id;
      if (sameJson(target.id, w.from)) target.id = w.id;
    }
  }
  for (const effect of entry.acceptedEffects ?? []) {
    if (global || effect.scope === scope) for (const row of effect.rows) rewriteId(registry, row, w);
  }
  if (global && registry.type(w.t)?.governs === 'tree') {
    if (!predictionOnly) entry.intent.scope = entry.scope = remappedScope(registry, entry.scope, [w]);
    for (const projection of entry.predictions ?? []) projection.scope = remappedScope(registry, projection.scope, [w]);
    for (const effect of entry.acceptedEffects ?? []) effect.scope = remappedScope(registry, effect.scope, [w]);
    mergePredictions(entry);
  }
}

// §7.7 write map: an ok result's map applies in the result's transaction.
export function applyWriteMap(replica, ctx, command, write) {
  if (command.predictions) return applyScopedWriteMap(replica, ctx, command, write);
  const { registry } = ctx;
  const retained = command.writeTargets !== undefined;
  const targets = command.writeTargets ??= [];
  for (const w of write) {
    const source = w.from ?? w.id;
    const previous = targets.find((target) => target.t === w.t && sameJson(target.from, source));
    if (previous) {
      const remap = { ...w, from: previous.id };
      for (const entry of laterUnacked(replica, command).filter(isQueued)) rewriteEntry(registry, entry, remap, { replay: true, scope: command.scope });
      if (!sameJson(previous.id, w.id)) {
        for (const delta of command.predict ?? []) rewriteId(registry, delta, remap);
      }
      if (previous.born !== undefined && w.born !== undefined && previous.born !== w.born) {
        for (const entry of laterUnacked(replica, command)) {
          for (const delta of effectsOf(entry).filter(({ scope }) => scope === command.scope).flatMap(({ d }) => d)) {
            if (delta.t !== w.t || !sameJson(delta.id, w.id)) continue;
            if (delta.born === previous.born) delta.born = w.born;
            if (delta.life?.[1] === previous.born) delta.life[1] = w.born;
          }
        }
      }
    } else if (retained && w.born !== undefined) {
      const predicted = (command.predict ?? []).filter((delta) => delta.t === w.t);
      for (const entry of laterUnacked(replica, command).filter(isQueued)) {
        if (!replica.entry(entry.localId)) continue;
        const unmapped = (entry.intent.d ?? []).some((delta) => delta.t === w.t && delta.life?.[0] === 'dead'
          && !sameJson(delta.id, source) && !sameJson(delta.id, w.id)
          && (predicted.length === 0 || predicted.some((known) => sameJson(known.id, delta.id))));
        if (unmapped) refuse(replica, ctx, entry, 'target-merged', { code: 'target-merged' });
      }
    }
    if (!previous && w.from !== undefined) {
      for (const entry of replica.entries().filter(isQueued)) {
        if (replica.entry(entry.localId) !== entry) continue; // ended by an earlier target-merged fold
        const deletesTarget = (entry.intent.d ?? []).some((delta) => delta.t === w.t && sameJson(delta.id, w.from) && delta.life?.[0] === 'dead');
        if (deletesTarget) {
          refuse(replica, ctx, entry, 'target-merged', { code: 'target-merged' });
          continue;
        }
        rewriteEntry(registry, entry, w, { scope: command.scope });
      }
      for (const delta of command.predict ?? []) rewriteId(registry, delta, w);
    }
    for (const delta of command.predict ?? []) {
      if (delta.t !== w.t || !sameJson(delta.id, w.id)) continue;
      for (const [name, stamp] of Object.entries(w.f ?? {})) moveRegister(replica, command, command.scope, delta, name, stamp);
      if (w.born !== undefined) moveRegister(replica, command, command.scope, delta, 'life', w.born);
    }
    const target = previous ?? { t: w.t, from: structuredClone(source), id: structuredClone(w.id) };
    target.id = structuredClone(w.id);
    if (w.born !== undefined) target.born = w.born;
    if (!previous) targets.push(target);
  }

  const mapped = write.flatMap((w) => [...(w.born !== undefined ? [w.born] : []), ...Object.values(w.f ?? {})]);
  replica.observe(mapped);
  replica.raiseAdmittedHigh(mapped);
  const physNow = ctx.deviceNow + replica.meta.serverOffsetMs;
  const clock = new Clock(replica.meta.hlc, ctx.actor, () => physNow);
  for (const entry of replica.entries().filter(isQueued)) {
    const named = [];
    for (const delta of effectsOf(entry).filter(({ scope }) => scope === command.scope).flatMap(({ d }) => d)) {
      for (const w of write) {
        if (delta.t !== w.t || !sameJson(delta.id, w.id)) continue;
        for (const name of Object.keys(w.f ?? {})) if (delta.f?.[name]) named.push([delta, name]);
        if (w.born !== undefined && delta.life) named.push([delta, 'life']);
      }
    }
    if (named.length === 0) continue;
    const n = clock.tick();
    for (const [delta, register] of named) moveRegister(replica, entry, command.scope, delta, register, n);
    replica.meta.hlcHigh = Stamp.max(replica.meta.hlcHigh, n);
  }
  replica.meta.hlc = clock.pair;
}

function applyScopedWriteMap(replica, ctx, command, write) {
  const { registry } = ctx;
  const retained = command.writeTargets !== undefined;
  const targets = command.writeTargets ??= [];
  for (const item of write) {
    const source = item.from ?? item.id;
    const previous = targets.find((target) => target.t === item.t && sameJson(target.from, source));
    const from = previous?.id ?? source;
    const mapping = { ...item, from };
    for (const entry of laterUnacked(replica, command).filter(isQueued)) {
      if (!replica.entry(entry.localId)) continue;
      const deletes = entry.scope === command.scope && (entry.intent.d ?? []).some((delta) => delta.t === item.t && delta.life?.[0] === 'dead'
        && (!previous && item.from !== undefined && sameJson(delta.id, from)
          || retained && !previous && item.born !== undefined && !sameJson(delta.id, source) && !sameJson(delta.id, item.id)));
      if (deletes) { refuse(replica, ctx, entry, 'target-merged', { code: 'target-merged' }); continue; }
      if (!sameJson(from, item.id)) rewriteEntry(registry, entry, mapping, { replay: !!previous, scope: command.scope });
    }
    if (!sameJson(from, item.id)) rewriteEntry(registry, command, mapping, { scope: command.scope, predictionOnly: true });
    if (previous?.born !== undefined && item.born !== undefined && previous.born !== item.born) {
      for (const entry of laterUnacked(replica, command).filter(isQueued)) for (const group of effectsOf(entry)) {
        if (group.scope !== command.scope) continue;
        for (const delta of group.d) {
          if (delta.t !== item.t || !sameJson(delta.id, item.id)) continue;
          if (delta.born === previous.born) delta.born = item.born;
          if (delta.life?.[1] === previous.born) delta.life[1] = item.born;
        }
      }
    }
    const target = previous ?? { t: item.t, from: structuredClone(source), id: structuredClone(item.id) };
    target.id = structuredClone(item.id);
    if (item.born !== undefined) target.born = item.born;
    if (!previous) targets.push(target);
  }
}

// The receipt's accepted versions reach what the command wrote at its own stamps: its predictions move
// to them, and what later queued entries carry of its ordinary deltas, of its predictions and, on a
// replay, of its previous receipt follows them. The numbered ordinary deltas themselves never change;
// views draw them at these versions (effectsOf). Later queued writes of a versioned register reclock.
export function applyAcceptedVersions(replica, ctx, command, effects, previous = []) {
  const stamps = effects.flatMap(({ rows }) => rows.flatMap(({ slots }) => slots.filter(({ version }) => version.kind === 'stamp').map(({ version }) => version.stamp)));
  replica.observe(stamps);
  replica.raiseAdmittedHigh(stamps);
  const later = laterUnacked(replica, command).filter(isQueued);
  const own = new Map(later.map((entry) => [entry, effectsOf(entry).flatMap(({ scope, d }) => d.flatMap((delta) => {
    const row = effects.find((effect) => effect.scope === scope)?.rows.find((row) => row.t === delta.t && sameJson(row.id, delta.id));
    return (row?.slots ?? []).flatMap(({ slot }) => {
      const register = slot.kind === 'life' ? 'life' : slot.kind === 'field' ? slot.name : null;
      const stamp = register === 'life' ? delta.life?.[1] : delta.f?.[register]?.[1];
      return stamp !== undefined && Stamp.compare(stamp, entry.stamp) >= 0 ? [{ delta, register, scope }] : [];
    });
  }))]));
  const stampIn = (delta, slot) => slot.kind === 'born' ? delta.born : slot.kind === 'life' ? delta.life?.[1] : delta.f?.[slot.name]?.[1];
  for (const { scope, rows } of effects) for (const row of rows) {
    const matches = (delta) => delta.t === row.t && sameJson(delta.id, row.id);
    const ordinary = scope === command.scope ? (command.intent.d ?? []).filter(matches) : [];
    const predicted = predictionsOf(command).filter((group) => group.scope === scope).flatMap(({ d }) => d).filter(matches);
    const prior = previous.find((effect) => effect.scope === scope)?.rows.find(matches)?.slots ?? [];
    for (const { slot, version } of row.slots) {
      if (version.kind !== 'stamp') continue;
      const n = version.stamp;
      const register = slot.kind === 'field' ? slot.name : 'life';
      const follow = (o) => {
        if (o !== undefined && o !== n) followRegister(replica, command, scope, row, register, o, n, { createsRecord: slot.kind === 'born', queuedOnly: true });
      };
      const before = prior.find((item) => item.slot.kind === slot.kind && item.slot.name === slot.name)?.version;
      if (before?.kind === 'stamp') follow(before.stamp);
      for (const delta of ordinary) follow(stampIn(delta, slot));
      for (const delta of predicted) {
        if (slot.kind !== 'born') moveRegister(replica, command, scope, delta, register, n, true);
        else if (delta.born !== undefined) {
          const old = delta.born;
          delta.born = n;
          if (delta.life?.[0] === 'alive' && delta.life[1] === old) delta.life = ['alive', n];
          follow(old);
        }
      }
    }
  }
  const clock = new Clock(replica.meta.hlc, ctx.actor, () => ctx.deviceNow + replica.meta.serverOffsetMs);
  for (const entry of later) {
    const named = own.get(entry);
    if (!named.length) continue;
    const stamp = clock.tick();
    for (const { delta, register, scope } of named) moveRegister(replica, entry, scope, delta, register, stamp, true);
    replica.meta.hlcHigh = Stamp.max(replica.meta.hlcHigh, stamp);
  }
  replica.meta.hlc = clock.pair;
}
