import { sameJson } from '../core/jcs.js';
import { orderedScopes } from '../core/receipts.js';

// Stored effects drive dependency and identity recovery. Active projections alone draw over confirmed rows,
// where an admitted entry's ordinary deltas draw at the versions its receipt accepted.
export function effectsOf(entry, { active = false } = {}) {
  if (!entry.predictions) return [{ scope: entry.scope, d: [...(entry.intent.d ?? []), ...(entry.predict ?? [])] }];
  const ordinary = active ? acceptedOrdinary(entry) : entry.intent.d ?? [];
  return entry.predictions.filter((projection) => !active || !projection.covered).map((projection) => ({
    scope: projection.scope,
    d: [...(projection.scope === entry.scope ? ordinary : []), ...projection.d],
  }));
}

// Copies of the numbered ordinary deltas, each register its origin receipt versions at that stamp.
function acceptedOrdinary(entry) {
  const rows = entry.acceptedEffects?.find((effect) => effect.scope === entry.scope)?.rows ?? [];
  return (entry.intent.d ?? []).map((delta) => {
    const slots = rows.find((row) => row.t === delta.t && sameJson(row.id, delta.id))?.slots ?? [];
    if (slots.length === 0) return delta;
    const accepted = structuredClone(delta);
    for (const { slot, version } of slots) {
      if (version.kind !== 'stamp') continue;
      if (slot.kind === 'born' && accepted.born !== undefined) accepted.born = version.stamp;
      if (slot.kind === 'life' && accepted.life) accepted.life = [accepted.life[0], version.stamp];
      if (slot.kind === 'field' && accepted.f?.[slot.name]) accepted.f[slot.name] = [accepted.f[slot.name][0], version.stamp];
    }
    return accepted;
  });
}

export function predictionsOf(entry) {
  return entry.predictions ?? [{ scope: entry.scope, d: entry.predict ?? [] }];
}

export function mergePredictions(entry) {
  if (!entry.predictions) return;
  const grouped = new Map();
  for (const projection of entry.predictions) {
    const existing = grouped.get(projection.scope);
    if (!existing) grouped.set(projection.scope, projection);
    else {
      existing.d.push(...projection.d);
      if (!projection.covered) delete existing.covered;
      if (projection.resultSeq !== undefined) existing.resultSeq = Math.max(existing.resultSeq ?? 0, projection.resultSeq);
    }
  }
  entry.predictions = orderedScopes(entry.scope, grouped.keys()).map((scope) => grouped.get(scope) ?? { scope, d: [] });
}
