import { localEffects, Refusal } from './admit.js';

export class ComposedProduct {
  constructor(registry, products) {
    const expected = Object.keys(registry.products).sort();
    if (JSON.stringify(expected) !== JSON.stringify(Object.keys(products).sort())
      || expected.some((name) => !products[name])) throw new Error('every composed product must have rules');
    this.registry = registry;
    this.products = { ...products };
    this.revisionsKept = Infinity;
  }

  productOfScope(ctx, scopeKey) {
    const kind = ctx.scope(scopeKey)?.kind
      ?? (scopeKey.startsWith('tree:') ? 'tree'
        : scopeKey.startsWith(`acct:${ctx.account}/overlay/`) ? 'overlay'
          : `product:${scopeKey.slice(`acct:${ctx.account}/`.length)}`);
    const name = this.registry.productOfScopeKind(kind);
    if (!Object.hasOwn(this.products, name)) throw new Error('scope has no composed product rules');
    return name;
  }

  elsewhere(state, type, id) {
    return Object.values(this.products).some((product) => product.elsewhere?.(state, type, id) ?? false);
  }

  isReplay(ctx, command) {
    return this.products[this.productOfScope(ctx, ctx.originScopeKey)].isReplay?.(ctx, command) ?? false;
  }

  discoverEffectScopes(ctx, command) {
    return this.products[this.productOfScope(ctx, ctx.originScopeKey)].discoverEffectScopes?.(ctx, command) ?? [];
  }

  runCommand(ctx, command) {
    const product = this.products[this.productOfScope(ctx, ctx.originScopeKey)];
    if (!product.runCommand) throw new Refusal('invalid');
    return product.runCommand(ctx, command);
  }

  effects(ctx, changes) {
    const names = new Set(changes.map((change) => this.registry.productOfScopeKind(change.type.scope)));
    if (!names.size || ctx.deltas.length) names.add(this.productOfScope(ctx, ctx.originScopeKey));
    const byScope = {};
    for (const name of [...names].sort()) {
      const product = this.products[name];
      const effects = product.effects ? product.effects(ctx, changes) : localEffects({
        localCheckTypes: product.localCheckTypes ?? [...this.registry.types.values()]
          .filter((type) => this.registry.productOfScopeKind(type.scope) === name).map((type) => type.type),
        check: (local, fullChanges) => product.check?.(local, fullChanges) ?? [],
      }, ctx, changes);
      for (const [scope, deltas] of Object.entries(effects.byScope)) (byScope[scope] ??= []).push(...deltas);
    }
    return { byScope };
  }

  pruneRevisions(ctx) {
    const product = this.products[this.productOfScope(ctx, ctx.scopeKey)];
    if (product.pruneRevisions) return product.pruneRevisions(ctx);
    const groups = new Map();
    for (const revision of ctx.revisions) {
      const key = JSON.stringify([revision.t, revision.id, revision.field]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(revision);
    }
    const drop = new Set();
    for (const revisions of groups.values()) {
      revisions.sort((a, b) => a.rev - b.rev);
      for (const revision of revisions.slice(0, Math.max(0, revisions.length - (product.revisionsKept ?? Infinity)))) drop.add(revision);
    }
    return ctx.revisions.filter((revision) => !drop.has(revision));
  }
}
