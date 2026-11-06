// The session owner confirms the account with the server, or restores an offline bound replica whose
// account matches the cached hint. A lapse retains that account's device work until sign-in;
// explicit sign-out or a different account makes every product forget its device residue.

export function restoredDeviceHolder(engine) {
  const meta = engine?.device?.meta;
  if (!engine || engine.closed || engine.signingOut || meta?.signOut || meta?.deviceCleanup || meta?.clearCredential || meta?.closingAccount) return null;
  const replica = engine.device?.activeReplica?.meta;
  return replica?.state === 'bound' ? replica.account : null;
}

export class DeviceSeat {
  constructor(products) {
    this.account = null;
    this.previousAccount = null;
    this.lapsed = false;
    this.confirmed = false;
    this.products = products;
  }

  // The durable bound replica remembers the holder, without granting session authority.
  restoreHolder(engine) {
    if (this.confirmed) return;
    this.previousAccount = restoredDeviceHolder(engine);
  }

  async finishDeviceCleanup(change) {
    await Promise.all(this.products.map(async (product) => product.forgetDevice?.(change)));
    if (this.previousAccount === change.previous) this.previousAccount = null;
  }

  // `me` is a user, null for a real 401, undefined for a blip. Returns null when nothing changes.
  receive(me, { signedOut = false } = {}) {
    if (me === undefined) {
      if (this.confirmed) return null;
      return { status: 'ghost', user: null, account: null, confirmed: false };
    }

    const previous = this.previousAccount;
    const next = me?.id ?? null;
    this.account = me ?? null;
    this.lapsed = !me && !!previous && !signedOut;
    if (next || signedOut) this.previousAccount = next;
    this.confirmed = true;
    if (previous && previous !== next && (next || signedOut)) {
      for (const product of this.products) forget(product, { previous, next });
    }
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
