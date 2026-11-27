// The session owner confirms the account with the server, or restores an offline bound replica whose
// account matches the cached hint. A lapse retains that account's device work until sign-in;
// explicit sign-out or a different account makes every product forget its device residue.

import { APP_LOCALE } from '../../platform/i18n/index.js';
import { t } from '../i18n/entry/index.js';

// How long the seat waits on one product's `sync.seatWillChange` before it changes without it.
export const SEAT_WILL_CHANGE_MS = 5000;

export function restoredDeviceHolder(engine) {
  const meta = engine?.device?.meta;
  if (!engine || engine.closed || engine.signingOut || meta?.signOut || meta?.deviceCleanup || meta?.clearCredential || meta?.closingAccount) return null;
  const replica = engine.device?.activeReplica?.meta;
  return replica?.state === 'bound' ? replica.account : null;
}

export class DeviceSeat {
  constructor(products, { reportCredential = () => {}, reportWillChange = () => {}, timers = globalThis } = {}) {
    this.account = null;
    this.previousAccount = null;
    this.lapsed = false;
    this.confirmed = false;
    this.products = products;
    this.reportCredential = reportCredential;
    this.reportWillChange = reportWillChange;
    this.timers = timers;
    this.credentialReported = false;
  }

  // What each product does before the seat changes (`sync.seatWillChange(engine)`), before a sign-in binds the device to an
  // account and before a sign-out finishes: in rail order, each awaited for at most SEAT_WILL_CHANGE_MS. A hook that throws
  // or runs past that is reported (`failed` or `timeout`) and the seat changes without it; a write it makes later is its
  // own to fence to the seat it began under.
  async willChange(engine) {
    for (const product of this.products) {
      const hook = product.sync?.seatWillChange;
      if (!hook) continue;
      let timer;
      const late = new Promise((resolve) => { timer = this.timers.setTimeout(() => resolve({ outcome: 'timeout' }), SEAT_WILL_CHANGE_MS); });
      const done = Promise.resolve().then(() => hook(engine)).then(() => null, (error) => ({ outcome: 'failed', error }));
      const missed = await Promise.race([done, late]);
      this.timers.clearTimeout(timer);
      if (missed) this.reportWillChange(product.id, missed.outcome, missed.error);
    }
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

  // Tells the engine whose credential the read found (engine.md §9.1): `me`'s account, null for none, undefined for a blip.
  // A tell that fails is reported once a page, and the read goes on.
  async tellCredential(engine, me) {
    try { await engine.credentialHeld(me === undefined ? undefined : me?.id ?? null); }
    catch (error) {
      if (!this.credentialReported) this.reportCredential(error);
      this.credentialReported = true;
    }
  }

  // Whether `me`, a read of the account, is the one that lapses the seat: no session, outside a sign-out, while the seat holds
  // an account and the engine's replica is still bound. The browser's cookie is then one no live session holds.
  lapses(me, engine, { signedOut = false } = {}) {
    return me === null && !signedOut && !this.lapsed && Boolean(this.previousAccount)
      && engine.device.activeReplica.meta.state === 'bound';
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

// The sign-in question in the shell's words (consistency 7d) around what a product counts of its signed-out work: `items`,
// each `{ label, detail? }`, the `total` they count, the noun `held` for what the account already holds, and the
// product's `onStep`. Its Discard asks again before it deletes anything (`discard`).
function accountWords({ items, total, held, onStep }) {
  const work = new Intl.ListFormat(APP_LOCALE, { type: 'conjunction' }).format(items.map((item) => item.label));
  return {
    title: t('shell.syncDecisions.addTitle'),
    lead: t('shell.syncDecisions.addLead', { work, held }),
    items,
    note: t('shell.syncDecisions.addNote', { count: total }),
    discard: { title: t('shell.syncDecisions.discardTitle', { work }), body: t('shell.syncDecisions.discardBody', { count: total }) },
    onStep,
  };
}

// What products say into the account-change questions (engine.md §7.10): a sign-in question one answers by itself, the
// sign-in question in its own words or in the shell's around its count, the steps of that question told back to it, and
// the line on what signing out discards from this tab. Each product's hook is isolated: one that throws reports the
// question it was asked (`adoption`, `signin`, `signout`, `step` or `notice`), and the shell asks as it would of a product
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

  // The sign-in question in the due product's own words (`sync.signInWords`), else in the shell's around the work it counts:
  // kind by kind (`sync.signInWork`), or by its one noun (`sync.signedOutWork`), counted by its `adoptionCount` or the
  // engine, beside the unsaved changes its device work holds (`due.pending`).
  async signInWords(engine, due) {
    const sync = this.syncOf(due.product);
    const own = await this.ask('signin', () => sync?.signInWords?.(engine, due));
    if (own) return this.heard(own);
    const work = await this.ask('signin', () => sync?.signInWork?.(engine, due));
    return this.heard(accountWords(work ?? await this.countedWork(engine, due)));
  }

  async countedWork(engine, due) {
    const sync = this.syncOf(due.product);
    const noun = sync?.signedOutWork;
    if (!noun) {
      const total = due.counted.length;
      return { items: [{ label: t('shell.syncDecisions.changes', { count: total }) }], total, held: t('shell.syncDecisions.heldWork') };
    }
    const count = await this.ask('signin', () => sync.adoptionCount?.(engine)) ?? due.count?.[noun.type] ?? 0;
    const pending = due.pending ?? 0;
    const items = [count > 0 || pending === 0 ? { label: noun.counted(count) } : null,
      pending > 0 ? { label: t('shell.syncDecisions.unsaved', { count: pending }) } : null].filter(Boolean);
    return { items, total: count + pending, held: noun.many };
  }

  // What each product does as a sign-out begins (`sync.signOutBegins`), before the engine sends what the device holds:
  // gym's Coach ends its running turn there, so the account's record carries the end.
  async signOutBegins(engine) {
    for (const product of this.products) await this.ask('begin', () => product.sync?.signOutBegins?.(engine));
  }

  // The device rows each product takes from the account's replica when its sign-out finishes (`sync.signOutForgets`),
  // read as the person decides it: `{ [product]: keys }`.
  async signOutForgets(engine) {
    const rows = {};
    for (const product of this.products) {
      const keys = await this.ask('forget', () => product.sync?.signOutForgets?.(engine));
      if (Array.isArray(keys) && keys.length) rows[product.id] = keys;
    }
    return rows;
  }

  // The sign-out question in the words of the product whose work it all is, where that product words its own.
  async signOutWords(engine, question) {
    for (const product of this.products) {
      const words = await this.ask('signout', () => product.sync?.signOutWords?.(engine, question));
      if (words) return { ...question, words: this.heard(words) };
    }
    return question;
  }

  // Every product's line on what signing out discards from this tab (`signOutNotice()`), asked as the question renders.
  signOutNotices() {
    return this.products.flatMap((product) => this.askNow('notice', () => product.signOutNotice?.()) ?? []);
  }

  // A product's words with each step the person takes told to it (`onStep`), a step it cannot hear dropped.
  heard(words) {
    return words && { ...words, onStep: (step) => this.askNow('step', () => words.onStep?.(step)) };
  }

  async ask(question, hook) {
    try {
      return await hook();
    } catch (error) {
      this.report(question, error);
      return undefined;
    }
  }

  askNow(question, hook) {
    try {
      return hook();
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
