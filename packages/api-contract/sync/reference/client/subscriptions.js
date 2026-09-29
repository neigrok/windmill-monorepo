// §7.9 subscriptions: product scopes, and a tree and overlay per governing record alive in drawn or in
// stored, so a held create's tree and a tree inside its board's delete window are in the set. A subscribe
// clears a known not-found scope, so its next pull boots it, and answers `gone` for a scope known gone,
// whose death is final; leaving the set forgets the scope and resolves its acked entries (§8.1). And
// the scopes in doubt, with their re-pull backoff.

import { moveEntry } from '../core/machines.js';
import { isAlive } from '../core/rows.js';
import { drawn, stored } from './views.js';

export function subscriptionsOf(replica, registry, products) {
  if (replica.meta.state !== 'bound') return [];
  const scopes = products.map((product) => `self/${product}`);
  const governing = registry.governingType;
  if (governing) {
    const productScope = `self/${registry.productOfScopeKind(governing.scope)}`;
    if (scopes.includes(productScope)) {
      const alive = new Set();
      for (const view of [drawn(replica, registry, productScope), stored(replica, registry, productScope)]) {
        for (const record of view.values()) if (record.t === governing.type && isAlive(record)) alive.add(record.id);
      }
      for (const id of [...alive].sort()) scopes.push(`tree/${id}`, `self/overlay/${id}`);
    }
  }
  return scopes.filter((scope) => !replica.known[scope]);
}

export function subscribe(replica, scope) {
  if (replica.known[scope] === 'gone') return 'gone';
  delete replica.known[scope];
  return null;
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

// Appendix B's re-pull backoff: base, ceiling, and how long a scope stays followed, not in doubt, before
// its k returns to 0.
export const REPULL = Object.freeze({ baseMs: 1000, ceilingMs: 30_000, settledMs: 30_000 });

// §7.9 scopes in doubt: when a scope an ignored end put in doubt is pulled again, and whether the live
// socket may follow it, as SenderWait models the sender's wait (§7.4). It models no socket and no
// timer: its caller tells it what the socket does, and asks which re-pulls are due. Times are the engine
// instance's monotonic ms, and `draw(bound)` answers the random sleep below `bound`.
export class Doubts {
  constructor(limits = REPULL) {
    this.limits = limits;
    this.scopes = new Map();
  }

  of(scope) {
    if (!this.scopes.has(scope)) this.scopes.set(scope, { k: 0, doubt: false, due: null, followedSince: null });
    return this.scopes.get(scope);
  }

  // The socket follows `scope` from `now`, not in doubt: a sub was sent, or a doubt ended while the scope
  // stayed followed (an ignored end in a page leaves the server's subscription as it was).
  followed(scope, now) {
    const state = this.of(scope);
    if (!state.doubt) state.followedSince = now;
  }

  // A frame's end, applied or ignored, ended the socket's following of `scope` (§6.8).
  unfollowed(scope) {
    this.of(scope).followedSince = null;
  }

  // An ignored end (§7.5 step 2) at `now`. A scope that stayed followed, not in doubt, for settledMs has
  // its k back at 0. A scope not yet in doubt comes into doubt, and its first re-pull is scheduled.
  end(scope, now, draw) {
    const state = this.of(scope);
    if (state.followedSince !== null && now - state.followedSince >= this.limits.settledMs) state.k = 0;
    state.followedSince = null;
    if (state.doubt) return;
    state.doubt = true;
    this.schedule(state, now, draw);
  }

  schedule(state, now, draw) {
    state.due = now + draw(Math.min(this.limits.ceilingMs, this.limits.baseMs * 2 ** state.k));
    state.k += 1;
  }

  // The scopes whose re-pull is due by `now`, taken: each is scheduled again only when its re-pull ends
  // with the scope still in doubt.
  due(now) {
    const taken = [];
    for (const [scope, state] of this.scopes) {
      if (state.doubt && state.due !== null && state.due <= now) {
        state.due = null;
        taken.push(scope);
      }
    }
    return taken.sort();
  }

  // A re-pull of `scope` ended at `now` (answered, failed or unanswered); still in doubt, the scope's
  // next re-pull is scheduled.
  repulled(scope, now, draw) {
    const state = this.of(scope);
    if (state.doubt && state.due === null) this.schedule(state, now, draw);
  }

  // A rows page of `scope` was applied: its doubt ends, and the socket may follow it again.
  rows(scope) {
    const state = this.of(scope);
    state.doubt = false;
    state.due = null;
  }

  mayFollow(scope) {
    return !this.of(scope).doubt;
  }

  // `scope` left the subscription set: its doubt and its k go.
  left(scope) {
    this.scopes.delete(scope);
  }

  // A sign-in, a sign-out or a re-identify of the active replica (§7.12) ends every doubt and returns
  // every k to 0, whether or not its id changed.
  clear() {
    this.scopes.clear();
  }
}
