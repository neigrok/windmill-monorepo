// §7.2 coalescing: a ready plain intent joins the last earlier entry on its record under the §7.2
// conditions, and an entry ever numbered takes no join. When the earlier entry is a create (its life
// alive at its born), the record is alive in neither drawn nor stored without the two entries, and the
// join leaves it dead, the earlier entry cancels with its dependents. A held delete may still be undone
// and a held create or revive released, so both views are read; a revive never cancels, since the
// registers it carries outlive a later death.

import { moveEntry } from '../core/machines.js';
import { joinRecord } from '../core/merge.js';
import { latticeOf, recordKey } from '../core/rows.js';
import { Stamp } from '../core/stamp.js';
import { sameJson } from '../core/jcs.js';
import { deltasOf, foldSilently, silentFoldOf } from './dependents.js';
import { drawn, stored } from './views.js';

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
  const except = new Set([...deltasOf(target), ...deltasOf(entry)]);
  const aliveWithout = (view) => view(replica, registry, entry.scope, except).get(recordKey(delta.t, delta.id))?.life?.[0] === 'alive';
  const creates = base.life?.[0] === 'alive' && base.born !== undefined && base.life[1] === base.born;
  const cancels = creates && !aliveWithout(drawn) && !aliveWithout(stored);
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
