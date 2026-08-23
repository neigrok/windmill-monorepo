// A product may only be handed an account the server confirmed on this document load, and
// confirmation lives in memory, never in storage. Replacing a confirmed account with a different
// one makes every product forget its device residue; a ghost becoming signed-in is not a replacement.

import { PRODUCTS } from '../products.js';

export class DeviceSeat {
  constructor(products = PRODUCTS) {
    this.account = null;
    this.confirmed = false;
    this.products = products;
  }

  // `me` is a user, null for a real 401, undefined for a blip. Returns null when nothing changes.
  receive(me) {
    if (me === undefined) {
      if (this.confirmed) return null;
      return { status: 'ghost', user: null, account: null, confirmed: false };
    }

    const previous = this.account?.id ?? null;
    const next = me?.id ?? null;
    this.account = me ?? null;
    this.confirmed = true;
    if (previous && previous !== next) for (const product of this.products) forget(product, { previous, next });
    return { status: me ? 'signed-in' : 'ghost', user: me ?? null, account: me ?? null, confirmed: true };
  }
}

// Guarded per product and never awaited: one hanging cleanup must not block the others.
function forget(product, change) {
  try {
    const done = product.forgetDevice?.(change);
    if (done && typeof done.then === 'function') done.catch((error) => complain(product, error));
  } catch (error) {
    complain(product, error);
  }
}

function complain(product, error) {
  console.error(`forgetDevice failed for product "${product?.id}" — its device residue may survive this account change`, error);
}
