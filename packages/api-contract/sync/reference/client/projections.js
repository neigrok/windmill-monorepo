import { orderedScopes } from '../core/receipts.js';

// Stored effects drive dependency and identity recovery. Active projections alone draw over confirmed rows.
export function effectsOf(entry, { active = false } = {}) {
  if (!entry.predictions) return [{ scope: entry.scope, d: [...(entry.intent.d ?? []), ...(entry.predict ?? [])] }];
  return entry.predictions.filter((projection) => !active || !projection.covered).map((projection) => ({
    scope: projection.scope,
    d: [...(projection.scope === entry.scope ? entry.intent.d ?? [] : []), ...projection.d],
  }));
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
