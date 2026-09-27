// §7.2 coalescing: a ready plain intent joins the last earlier entry on its record under the §7.2
// conditions, and an entry ever numbered takes no join; a create or revive that the join leaves dead
// cancels with its dependents.

import { moveEntry } from '../core/machines.js';
import { joinRecord } from '../core/merge.js';
import { latticeOf } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { sameJson } from '../core/jcs.js';
import { foldSilently, silentFoldOf } from './dependents.js';

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
  if (entry.state !== 'ready' || !isPlain(entry)) return false;
  const [delta] = entry.intent.d;
  const earlier = replica.entries(entry.scope).filter((other) => other.commitOrder < entry.commitOrder);
  const target = earlier.filter((other) => touches(other, delta.t, delta.id)).pop();
  if (!target || target.state !== 'ready' || target.numbered === true || !isPlain(target)) return false;
  if (earlier.some((other) => other.commitOrder > target.commitOrder && other.intent.cmd !== undefined)) return false;
  if (delta.x && actorOf(target) !== actorOf(entry)) return false;

  const [base] = target.intent.d;
  const cancels = base.life?.[0] === 'alive';
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
    const parts = silentFoldOf(replica, registry, [{ entry: target, deltas: [base] }]);
    moveEntry(replica, ended, target, 'coalesce');
    foldSilently(replica, ended, parts);
  }
  return true;
}
