import { ProbeProduct } from '../probe/product.js';
import { localEffects } from '../server/admit.js';

// Corpus-only hooks: the fixture declares targets separately from the effects it produces.
export class EffectPlanProduct extends ProbeProduct {
  constructor(plan) {
    super();
    this.plan = plan;
    if (plan.legacyTypes) this.localCheckTypes = plan.legacyTypes;
  }

  discoverEffectScopes(ctx, cmd) {
    return [...super.discoverEffectScopes(ctx, cmd), ...(this.plan.declared ?? [])];
  }

  runCommand(ctx, cmd) {
    const result = super.runCommand(ctx, cmd);
    return { ...result, into: [...(result.into ?? []), ...Object.entries(this.plan.command ?? {}).map(([scopeKey, deltas]) => ({ scopeKey, deltas }))] };
  }

  effects(ctx, changes) {
    const local = localEffects(this, ctx, changes);
    const byScope = structuredClone(this.plan.check ?? {});
    for (const [key, deltas] of Object.entries(local.byScope)) byScope[key] = [...deltas, ...(byScope[key] ?? [])];
    return { byScope };
  }
}
