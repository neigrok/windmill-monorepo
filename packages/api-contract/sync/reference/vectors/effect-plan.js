import { ProbeProduct } from '../probe/product.js';

// Corpus-only hooks: the fixture declares targets separately from the effects it produces.
export class EffectPlanProduct extends ProbeProduct {
  constructor(plan) {
    super();
    this.plan = plan;
  }

  discoverEffectScopes(ctx, cmd) {
    return [...super.discoverEffectScopes(ctx, cmd), ...(this.plan.declared ?? [])];
  }

  runCommand(ctx, cmd) {
    const result = super.runCommand(ctx, cmd);
    return { ...result, into: [...(result.into ?? []), ...Object.entries(this.plan.command ?? {}).map(([scopeKey, deltas]) => ({ scopeKey, deltas }))] };
  }

  effects(ctx, changes) {
    const byScope = structuredClone(this.plan.check ?? {});
    byScope[ctx.scopeKey] = [...super.check(ctx, changes), ...(byScope[ctx.scopeKey] ?? [])];
    return { byScope };
  }
}
