// Who this DEVICE is signed in as — and what happens when that changes. Two rules live here
// because they are the same rule seen from two sides: a browser may only hand a product an account
// the SERVER confirmed on this document load, and when a confirmed account is replaced every
// product must give up what it keeps on the device.
//
// A browser keeps a lot of a person on the device — journal pages, roadmap trees and per-node
// notes, gym logs — and none of it used to be given up when the account changed, so on a shared or
// handed-over browser the next person read the previous one's work and, the moment they edited it,
// wrote it into their own account on the server (audit JOURNAL-1, WEB-4).
//
// The remembered auth hint may PAINT — it exists so a returning tab doesn't flash signed-out — but
// it may never be handed to a product as an account, because a hint is the device answering "who
// is holding me?", and the device cannot tell the owner from a stranger. Only /v1/me can. So a
// cold boot that cannot reach the server is NOBODY here, and a product opens signed-out even though
// the pages are still on the disk under them. That is the deliberate cost: an attacker who holds
// the device can turn the wifi off, and without this rule that alone would open the last owner's
// journal for them. Nothing is lost — the data returns when the network does.
//
// Once a load HAS confirmed an account, a later blip changes nothing: the network dying mid-session
// must not throw anyone out of their own work. Confirmation lives in memory only, never in storage,
// so it cannot survive the reload it exists to guard.
//
// Forgetting is likewise decided off confirmed accounts alone. A ghost becoming signed-in is
// deliberately not that moment — it is the claim, and anonymous work on this device is meant to
// follow the person who signs in — and neither is an unconfirmed hint: forgetting on a hint would
// let a stale or planted one delete work the server never said belonged to anyone. A hinted account
// that turns out to be somebody else is covered by the other half of the seam instead, the one the
// products own: their stores are scoped per account, so an account that was never confirmed here
// was never readable there either.

import { PRODUCTS } from '../products.js';

export class DeviceSeat {
  constructor(products = PRODUCTS) {
    this.account = null;
    this.confirmed = false;
    this.products = products;
  }

  // The answer from /v1/me, from a sign-in, or from a sign-out: a user, null for a real 401,
  // undefined for a blip (server error or unreachable). Returns the face to paint and the account
  // to hand products — or null when the answer changes nothing at all.
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

// Each product is guarded on its own, and nothing here is awaited. One product's broken or hanging
// cleanup must not leave another product's residue on the device, and must never keep the person
// signed in while it decides — sign-out returns at once and the forgetting finishes behind it.
// A product that declares nothing has no device store to forget and is skipped.
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
