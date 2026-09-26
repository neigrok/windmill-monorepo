// §7.2 coalescing: a ready plain intent joins the last earlier entry on its record under the §7.2
// conditions; a never-numbered create or revive that the join leaves dead cancels with its dependents.

import { moveEntry } from '../core/machines.js';
import { joinRecord } from '../core/merge.js';
import { latticeOf } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { sameJson } from '../core/jcs.js';
import { Dependents, isEmpty, removeDependent } from './dependents.js';

export function isPlain(entry) {
  const { intent } = entry;
  return (intent.d ?? []).length === 1 && !intent.guard?.length && intent.cmd === undefined && !entry.predict?.length;
}

export function touches(entry, t, id) {
  return [...(entry.intent.d ?? []), ...(entry.predict ?? [])].some((delta) => delta.t === t && sameJson(delta.id, id));
}

function actorOf(entry) {
  return Stamp.parse(entry.stamp).actor;
}

export function coalesce(replica, registry, ended, entry) {
  if (entry.state !== 'ready' || !isPlain(entry) || entry.orphanOf !== undefined) return false;
  const [delta] = entry.intent.d;
  const earlier = replica.entries(entry.scope).filter((other) => other.commitOrder < entry.commitOrder);
  const target = earlier.filter((other) => touches(other, delta.t, delta.id)).pop();
  if (!target || target.state !== 'ready' || !isPlain(target) || target.orphanOf !== undefined) return false;
  if (earlier.some((other) => other.commitOrder > target.commitOrder && other.intent.cmd !== undefined)) return false;
  if (delta.x && actorOf(target) !== actorOf(entry)) return false;

  const [base] = target.intent.d;
  const cancels = base.life?.[0] === 'alive' && target.numbered !== true;
  const joined = { t: base.t, id: base.id, ...joinRecord(registry.type(delta.t), latticeOf(base), latticeOf(delta)) };
  if (base.x || delta.x) {
    joined.x = { ...(base.x ?? {}) };
    for (const [name, write] of Object.entries(delta.x ?? {})) {
      joined.x[name] = { text: write.text, base: base.x?.[name]?.base ?? write.base };
    }
    target.baseTexts = { ...(entry.baseTexts ?? {}), ...(target.baseTexts ?? {}) };
  }
  target.intent.d = [joined];
  moveEntry(replica, ended, entry, 'coalesce');
  if (joined.born !== undefined && joined.life?.[0] === 'dead' && cancels) {
    moveEntry(replica, ended, target, 'coalesce');
    cancelDependents(replica, registry, ended, target, base);
  }
  return true;
}

// The cancelled record's dependents fold silently: their dependent part is removed with no notice, and
// an entry left empty ends coalesced. Sent entries stay as they are.
function cancelDependents(replica, registry, ended, cancelled, created) {
  const dependents = new Dependents(registry, cancelled.scope, [created]);
  for (const entry of replica.entries().filter((other) => other.commitOrder > cancelled.commitOrder)) {
    if (entry.state !== 'held' && entry.state !== 'ready') continue;
    const part = dependents.of(entry);
    if (!part.any) continue;
    dependents.absorb(entry.scope, [...part.removed, ...(part.cmdGone ? entry.predict ?? [] : [])]);
    removeDependent(entry, part);
    if (isEmpty(entry)) moveEntry(replica, ended, entry, 'cancel');
  }
}
