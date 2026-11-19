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

// What products say into the account-change questions (engine.md §7.10): a sign-in question one answers by itself, its
// count in the product's own records, and a question one words itself. Each product's hook is isolated: one that throws
// reports the question it was asked (`adoption`, `signin` or `signout`), and the shell asks as it would of a product
// that says nothing, in its own words and the engine's count.
export class ProductQuestions {
  constructor(products, report = () => {}) {
    this.products = products;
    this.report = report;
  }

  // The answer the due product gives by itself, or nothing for the person to give.
  adoptionAnswer(engine, due) {
    return this.ask('adoption', () => this.syncOf(due.product)?.adoptionAnswer?.(engine, due));
  }

  // How many of its records the due product counts, or nothing for the engine's count.
  adoptionCount(engine, due) {
    return this.ask('signin', () => this.syncOf(due.product)?.adoptionCount?.(engine));
  }

  signInWords(engine, due) {
    return this.ask('signin', () => this.syncOf(due.product)?.signInWords?.(engine, due));
  }

  // The sign-out question in the words of the product whose work it all is, where that product words its own.
  async signOutWords(engine, question) {
    for (const product of this.products) {
      const words = await this.ask('signout', () => product.sync?.signOutWords?.(engine, question));
      if (words) return { ...question, words };
    }
    return question;
  }

  async ask(question, hook) {
    try {
      return await hook();
    } catch (error) {
      this.report(question, error);
      return undefined;
    }
  }

  syncOf(id) {
    return this.products.find((product) => product.id === id)?.sync;
  }
}

export class DocumentDataScope {
  constructor({ invalidate = () => {}, report = () => {} } = {}) {
    this.snapshot = Object.freeze({ epoch: 0, phase: 'pending', owner: null });
    this.listeners = new Set();
    this.invalidate = invalidate;
    this.report = report;
    this.ticket = null;
    this.read = Object.freeze({
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    });
  }

  publish(snapshot) {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }

  begin(owner) {
    const target = Object.freeze({ ...owner });
    const ticket = Object.freeze({ epoch: this.snapshot.epoch + 1, owner: target });
    this.ticket = ticket;
    this.snapshot = Object.freeze({ epoch: ticket.epoch, phase: 'changing', owner: target });
    try { this.invalidate(); } catch { this.report(); }
    for (const listener of this.listeners) listener();
    return ticket;
  }

  reconcile(engine, ticket = this.ticket) {
    if (!engine || engine.closed || engine.restoring || engine.signingOut) return false;
    const meta = engine.device?.meta;
    if (!meta || meta.signOut || meta.deviceCleanup || meta.clearCredential || meta.closingAccount) return false;
    const replica = engine.device.activeReplica?.meta;
    if (!replica || !['anon', 'bound'].includes(replica.state)) return false;
    const owner = replica.state === 'bound' ? { kind: 'account', id: replica.account } : { kind: 'anonymous' };
    if (this.snapshot.phase === 'changing') {
      if (ticket !== this.ticket || ticket.epoch !== this.snapshot.epoch || !this.sameOwner(owner, ticket.owner)) return false;
      this.publish({ ...this.snapshot, phase: 'ready' });
      return true;
    }
    if (this.snapshot.phase === 'ready') return this.sameOwner(owner, this.snapshot.owner);
    this.publish({ ...this.snapshot, phase: 'ready', owner: Object.freeze(owner) });
    return true;
  }

  sameOwner(left, right) { return left?.kind === right?.kind && left?.id === right?.id; }
}
