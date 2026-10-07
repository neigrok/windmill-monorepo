// @ts-check
// §11 the standard actions every product names: a removal, held per the entity, and a move that writes
// one order key and nothing for a drop in place.

import { Decision } from './actions.js';
import { Plan } from './plans.js';
import { Refused } from './refusals.js';
import { precondition } from './values.js';

/**
 * @template E
 * @template R
 */
export class Remove {
  /**
   * @param {import('./entities.js').Id<E>} id
   * @param {import('./refusals.js').Refusals<R>} refusals
   */
  constructor(id, refusals) {
    precondition(id.entity.isRemovable, `${id.entity.type} is not Removable`);
    this.id = id;
    this.refusals = refusals;
    Object.freeze(this);
  }

  get scope() {
    return this.id.entity.scope;
  }

  /** @param {import('./reading.js').Reader} read */
  load(read) {
    return read.repository(this.id.entity).find(this.id, 'drawn');
  }

  // A record the person cannot see, one inside its delete window included, is not removed again.
  /**
   * @param {E | null} loaded
   * @returns {import('./actions.js').Decision<null, R>}
   */
  decide(loaded) {
    if (loaded === null) return Decision.unchanged(null);
    const plan = new Plan();
    plan.remove(this.id);
    return Decision.write(plan, null);
  }
}

/**
 * @template {import('./entities.js').Writable<any>} E
 * @template R
 */
export class Move {
  /**
   * @param {import('./entities.js').Id<E>} id
   * @param {import('./entities.js').Id<E> | null} below
   * @param {import('./refusals.js').Refusals<R>} refusals
   */
  constructor(id, below, refusals) {
    precondition(id.entity.isOrdered, `${id.entity.type} is not Ordered`);
    this.id = id;
    this.below = below;
    this.refusals = refusals;
    Object.freeze(this);
  }

  get scope() {
    return this.id.entity.scope;
  }

  // The member and the one above it, in `drawn` order.
  /**
   * @param {import('./reading.js').Reader} read
   * @returns {{ moving: E | null, above: import('./entities.js').Id<E> | null }}
   */
  load(read) {
    const members = read.repository(this.id.entity).all('drawn');
    const index = members.findIndex((member) => member.id.equals(this.id));
    if (index < 0) return { moving: null, above: null };
    return { moving: /** @type {E} */ (members[index]), above: members[index - 1]?.id ?? null };
  }

  /**
   * @param {{ moving: E | null, above: import('./entities.js').Id<E> | null }} loaded
   * @returns {import('./actions.js').Decision<null, R>}
   */
  decide(loaded) {
    if (loaded.moving === null) return Decision.refuse(this.refusals.ofRefused(new Refused('unknown-record', this.id.ref, null, 'predicted')));
    const sameId = (/** @type {import('./entities.js').Id<E> | null} */ other) => (this.below === null ? other === null : other !== null && this.below.equals(other));
    if (sameId(this.id) || sameId(loaded.above)) return Decision.unchanged(null);
    const plan = new Plan();
    plan.move(this.id, this.below);
    return Decision.write(plan, null);
  }
}
