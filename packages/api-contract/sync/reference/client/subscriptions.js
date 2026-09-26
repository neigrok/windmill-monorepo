// §7.9 subscriptions: product scopes, and a tree and overlay per alive governing record. Leaving the set
// forgets the scope and resolves its acked entries (§8.1).

import { moveEntry } from '../core/machines.js';
import { isAlive } from '../core/rows.js';
import { drawn } from './views.js';

export function subscriptionsOf(replica, registry, products) {
  if (replica.meta.state !== 'bound') return [];
  const scopes = products.map((product) => `self/${product}`);
  const governing = registry.governingType;
  if (governing) {
    const productScope = `self/${registry.productOfScopeKind(governing.scope)}`;
    if (scopes.includes(productScope)) {
      for (const record of drawn(replica, registry, productScope).values()) {
        if (record.t === governing.type && isAlive(record)) scopes.push(`tree/${record.id}`, `self/overlay/${record.id}`);
      }
    }
  }
  return scopes.filter((scope) => !replica.known[scope]);
}

export function unsubscribe(replica, ctx, scope) {
  replica.forgetScope(scope);
  for (const entry of replica.entries(scope)) if (entry.state === 'acked') moveEntry(replica, ctx.ended, entry, 'resolve');
}

// Unsubscribes every held scope no longer in `scopes`; an acked entry of a scope outside the set
// resolves, whether or not the replica ever pulled it.
export function reconcile(replica, ctx, scopes) {
  for (const scope of Object.keys(replica.cursors)) if (!scopes.includes(scope)) unsubscribe(replica, ctx, scope);
  for (const entry of replica.entries()) {
    if (entry.state === 'acked' && !scopes.includes(entry.scope)) moveEntry(replica, ctx.ended, entry, 'resolve');
  }
}

export function firstPullComplete(replica, scope, scopes) {
  if (!scopes.includes(scope)) return true;
  return replica.cursors[scope]?.booted === true;
}
