// web-device-parity §5: what the journal's bundle before the engine kept in this browser's storage, carried into the
// engine's replica through the domain's actions (domain/carry.js). A seat's pages go only into the replica they belong
// to, while it is active: an account's (`wm.journal.*.u.<id>`) into that account's bound replica, those written signed
// out (`.anon`) into the anon replica. A run pins the engine's active binding as it starts, and the engine commits its
// acts only while that binding stands: a sign-in or a sign-out between ends the run, and the next replica's run carries
// what is still its. Each act's pages leave their stores as it commits, so a run that stops between acts leaves only
// what is still owed, and a page is carried once, whichever seat comes next. Before the seat changes, the pages the
// replica's ledger records leave their stores too (`settleSeat`), so a Discard of the replica takes with it the old pages
// it counted, as the work they were carried into; the pages not yet carried, and the entries that do not read, wait for
// that seat's next replica. An account's closure deletes every page of its seat (`forgetClosedAccount`). The pages that
// bundle could not attribute (`.unclaimed`) stay in the browser's storage until Settings restores them, which takes an
// account, or discards them, signed in or out, or a sign-out forgets them (`forgetUnclaimedPages`).

import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { FixedZone } from '../../platform/domain-kit/time.js';
import { hashText } from '../../platform/sync/core/encoding.js';
import { ReplicaChanged } from '../../platform/sync/engine.js';
import { syncSession } from '../../platform/sync/session.js';
import { track as trackEvent } from '../../telemetry/beacon.js';
import { countBucket } from '../../telemetry/countBucket.js';
import { captureError } from '../../telemetry/sentry.js';
import { CarryLedger, OldStore, Seat, SeatPages } from './domain/carry.js';
import { normalizePage } from './pages.js';

const CARRY_LOCK = 'windmill-journal-carry';

// How many pages one act writes, so no write holds the device's store for long.
const PAGES_PER_ACT = 20;

// The carry's acts read no local date.
const ZONE = new FixedZone(0);

// How a part of an act wrote its page (CarryPage, KeepAsDraft); `held` wrote nothing.
const WROTE = new Set(['claimed', 'drafted', 'recovered']);

// What the journal's first bundle on the engine kept in the engine's device metadata, which the engine does not declare.
const LEFTOVERS = Object.freeze(['journalUnclaimed', 'journalMigration', 'journalMigrationEntries']);

// A failure to Sentry under its static operation, tagged with the step it met, with the error's stack where there is one.
/** @param {string} operation @param {'read' | 'write' | 'clear' | 'leftovers' | 'restore' | 'discard' | 'forget'} stage @param {any} [error] */
function reportFailure(operation, stage, error = null) {
  captureError('journal', operation, error?.stack ?? '', '/journal', { stage });
}

const runnerOf = (engine) => new ActionRunner(new EngineReplica(engine), engine.registry, ZONE);

// The journal's stores in this browser's storage, read and changed whole.
export class OldStores {
  /** @param {Storage | null} [storage] the browser's own where none is given */
  constructor(storage = null) {
    this.given = storage;
  }

  // Reading the browser's storage can itself throw, where the browser refuses it.
  get storage() { return this.given ?? globalThis.localStorage; }

  // Every journal store this browser keeps, in key order. Throws where the browser refuses its storage.
  read() {
    const { storage } = this;
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) keys.push(storage.key(index));
    return keys.filter((key) => key !== null && Seat.ofKey(key) !== null).sort()
      .flatMap((key) => [OldStore.read(key, storage.getItem(key) ?? '')].filter((store) => store !== null));
  }

  // Each store of `seat` as it holds now, without its pages `done` names and its copies of the account's pages
  // (`OldStore.rest`): deleted where nothing else is left, rewritten otherwise. A page another writer changed since it was
  // carried has other words, so another digest, and stays, as does an entry that does not read. Answers the pages that
  // left. Throws where the browser refuses its storage, the stores before the refusal settled.
  settle(seat, done) {
    const gone = [];
    for (const store of this.read().filter((each) => each.seat.equals(seat))) {
      const rest = store.rest(done);
      if (rest.kind === 'keep') continue;
      if (rest.kind === 'forget') this.storage.removeItem(store.key);
      else this.storage.setItem(store.key, rest.raw);
      gone.push(...rest.gone);
    }
    return gone;
  }

  // Every store of `seat` deleted whole, its entries that do not read among them. Answers the pages that left. Throws where
  // the browser refuses its storage, the stores before the refusal gone.
  forget(seat) {
    const gone = [];
    for (const store of this.read().filter((each) => each.seat.equals(seat))) {
      this.storage.removeItem(store.key);
      gone.push(...store.pages);
    }
    return gone;
  }

  // One time, for the leftovers of the journal's first bundle on the engine: the entries of each store whose carry that
  // bundle's migration recorded go from the store, by its own records: `markers`, a whole store's bytes by key, and
  // `receipts`, each page by its seat and its page as that migration read it. The stores of pages it returned are left
  // alone.
  forgetMigrated(markers, receipts) {
    const { storage } = this;
    for (const store of this.read()) {
      if (OldStore.isReturned(store.key)) continue;
      if (markers[store.key] === hashText(store.raw)) {
        storage.removeItem(store.key);
        continue;
      }
      let entries;
      try { entries = JSON.parse(store.raw); } catch { continue; }
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
      const seat = store.key.endsWith('.unclaimed') || store.key === 'wm.journal.pages' ? 'quarantine'
        : store.key.includes('.u.') ? store.key.split('.u.')[1] : 'anon';
      const first = !store.key.startsWith('wm.journal.v2.');
      const kept = Object.fromEntries(Object.entries(entries).filter(([day, entry]) => {
        const page = { ...normalizePage(entry?.page), day };
        if (first) {
          page.mood = page.mood >= 1 && page.mood <= 5 ? page.mood * 2 - 1 : null;
          page.energy = ({ 1: 2, 2: 5, 3: 8 })[page.energy] ?? null;
        }
        return !receipts[hashText(JSON.stringify([seat, page]))];
      }));
      if (Object.keys(kept).length === Object.keys(entries).length) continue;
      if (Object.keys(kept).length === 0) storage.removeItem(store.key);
      else storage.setItem(store.key, JSON.stringify(kept));
    }
  }

  /** @param {{ key: string, raw: string }} store */
  put({ key, raw }) { this.storage.setItem(key, raw); }
}

export class CarryOver {
  /** @param {any} engine a `BrowserSyncEngine` */
  constructor(engine, { stores = new OldStores(), locks = globalThis.navigator?.locks, track = trackEvent, report = reportFailure } = {}) {
    this.engine = engine;
    this.stores = stores;
    this.locks = locks;
    this.track = track;
    this.report = report;
    this.binding = null;
    this.running = Promise.resolve();
    this.unreadTold = false;
    this.clearTold = false;
  }

  // A run at once, and again whenever another binding becomes active: a sign-in or a sign-out, once its question is
  // answered. Answers once the first run ends, and never rejects, so the engine opens whatever the stores hold.
  start() {
    this.engine.observeEngine(() => this.consider());
    this.consider();
    return this.running;
  }

  consider() {
    const { engine } = this;
    if (engine.closed || engine.getSnapshot().pendingSignIn || engine.signingOut || engine.device.meta.signOut) return;
    const binding = engine.activeBinding();
    if (binding === this.binding) return;
    this.binding = binding;
    this.running = this.running.then(() => this.run()).catch((error) => this.report('journal-migration', 'write', error));
  }

  // One run on this browser at a time. Every tab shares the device and its active replica, so a tab that finds another
  // running leaves the carry to it: that tab runs again for whichever binding stands once its run ends.
  run() {
    if (!this.locks) return this.carry();
    return this.locks.request(CARRY_LOCK, { ifAvailable: true }, (lock) => (lock === null ? undefined : this.carry()));
  }

  // The account's copies of its own pages go first: its pull brings them. Then the acts, each act's pages leaving their
  // stores as it commits. An act the domain refuses or that fails ends the run, told, and one a sign-in or a sign-out
  // overtakes ends it quietly; either way that act's pages and those after it stay owed to the next run.
  async carry() {
    const { engine } = this;
    const binding = engine.activeBinding();
    const seat = Seat.ofReplica(engine.device.activeReplica.meta);
    if (seat === null) return;
    await this.returnLeftovers();
    const pages = new SeatPages(seat, this.readStores());
    if (pages.stores.length === 0) return;
    const runner = runnerOf(engine);
    let gone = this.settle(seat, new Set());
    let written = 0;
    let owed = pages.pages.length;
    let ended = null;
    try {
      for (const act of pages.carrying(PAGES_PER_ACT)) {
        const outcome = await runner.runComposed(act.parts, { binding });
        if (outcome.kind === 'refused') {
          ended = 'refused';
          break;
        }
        if (outcome.kind === 'committed') written += outcome.results.filter((result) => WROTE.has(result)).length;
        owed -= act.pages.length;
        gone += this.settle(seat, new Set(act.pages.map((page) => page.digest)));
      }
    } catch (error) {
      if (!(error instanceof ReplicaChanged)) {
        this.report('journal-migration', 'write', error);
        ended = 'failed';
      }
    }
    if (written > 0) this.tell(seat, 'carried', written);
    else if (gone > 0) this.tell(seat, 'cleared', gone);
    if (ended !== null) this.tell(seat, ended, owed);
  }

  // The seat's stores give up the pages `done` names (`OldStores.settle`), answering how many left them. A store the
  // browser will not change is reported once a page load and settled by a later run.
  settle(seat, done) {
    try {
      return this.stores.settle(seat, done).length;
    } catch (error) {
      if (!this.clearTold) this.report('journal-migration', 'clear', error);
      this.clearTold = true;
      return 0;
    }
  }

  // Every store, none where the browser refuses its storage. A refusal, or an entry that does not read as a page, is
  // reported once a page load; the entry stays where it is.
  readStores() {
    let stores = [];
    let failure = null;
    try { stores = this.stores.read(); } catch (error) { failure = error; }
    if (!this.unreadTold && (failure !== null || stores.some((store) => store.unreadable > 0))) {
      this.report('journal-migration', 'read', failure);
      this.unreadTold = true;
    }
    return stores;
  }

  // Once, for a browser that ran the journal's first bundle on the engine, whose migration kept the pages it could not
  // attribute and its own records in the engine's device metadata, which the engine does not declare: the entries of the
  // stores it recorded as carried go from them, the unattributed pages return to this browser's storage as stores of
  // their own, and the three keys go from the metadata in the engine's one door to it, the journal's only write of the
  // device rather than of a replica. Where an old tab wrote the pages again meanwhile, the next run returns them.
  async returnLeftovers() {
    const { meta } = this.engine.device;
    if (!LEFTOVERS.some((key) => Object.hasOwn(meta, key))) return;
    const unclaimed = meta.journalUnclaimed ?? [];
    let returned;
    try {
      this.stores.forgetMigrated(meta.journalMigration ?? {}, meta.journalMigrationEntries ?? {});
      for (const page of unclaimed) this.stores.put(OldStore.returned(page));
      returned = await this.engine.write(null, (device) => {
        if (jcs(device.meta.journalUnclaimed ?? []) !== jcs(unclaimed)) return false;
        for (const key of LEFTOVERS) delete device.meta[key];
        return true;
      });
    } catch (error) {
      this.report('journal-migration', 'leftovers', error);
      return;
    }
    if (returned && unclaimed.length > 0) this.tell(Seat.unclaimed, 'returned', unclaimed.length);
  }

  tell(seat, outcome, pages) {
    this.track('journal_carry', { seat: seat.kind, outcome, pages: countBucket(pages) });
  }
}

// Before the seat changes (a sign-in, a sign-out's Keep or Discard, the account's closure), the active seat's stores
// give up every page its replica's ledger records, so a page carried there is never carried again into the next
// replica, and a Discard takes the old pages it counted as the work they were carried into, and no other: the pages not
// yet carried, and the entries that do not read, wait for that seat's next replica.
export function settleSeat(engine, { stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  if (!engine || engine.closed) return;
  const seat = Seat.ofReplica(engine.device.activeReplica.meta);
  if (seat === null) return;
  try {
    const gone = stores.settle(seat, CarryLedger.of(engine.readDeviceRows('journal')[CarryLedger.key(seat)] ?? null));
    if (gone.length > 0) track('journal_carry', { seat: seat.kind, outcome: 'cleared', pages: countBucket(gone.length) });
  } catch (error) {
    report('journal-migration', 'clear', error);
  }
}

// The account's closure (the shell's `forgetDevice` with `closed`): the account no longer exists, so every page this
// browser kept of its seat leaves its stores, carried or not, the entries that do not read among them.
export function forgetClosedAccount(account, { stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  try {
    const gone = stores.forget(Seat.of(account));
    if (gone.length > 0) track('journal_carry', { seat: 'account', outcome: 'cleared', pages: countBucket(gone.length) });
  } catch (error) {
    report('journal-migration', 'clear', error);
  }
}

// A sign-out that finished, Keep or Discard (the shell's `forgetDevice`), forgets the pages the bundle before the engine
// could not attribute, every store of them deleted whole, the entries that do not read and the first version's cached
// copies among them: no account can be shown to own them (web-device-parity R-9), so the next person to sign in on this
// browser is not offered them. The pages the journal's first bundle on the engine kept in the device's metadata and that
// have not yet returned to storage (`returnLeftovers`) go first, so a carry run that returns them meanwhile returns them
// into stores this then deletes. Answers how many pages went, as Settings would have listed them.
export async function forgetUnclaimedPages({ engine = syncSession.engine, stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  try {
    const kept = engine && !engine.closed ? engine.device.meta.journalUnclaimed ?? [] : [];
    if (kept.length > 0) await engine.write(null, (device) => { delete device.meta.journalUnclaimed; });
    const forgotten = kept.length + new Set(stores.forget(Seat.unclaimed).filter((page) => !page.copy).map((page) => page.digest)).size;
    if (forgotten > 0) track('journal_unclaimed', { action: 'forget', outcome: 'ok', pages: countBucket(forgotten) });
    return forgotten;
  } catch (error) {
    report('journal-forget', 'forget', error);
    track('journal_unclaimed', { action: 'forget', outcome: 'failed', pages: countBucket(0) });
    return 0;
  }
}

// The pages this browser kept that the bundle before the engine could not attribute, as Settings lists them: a day
// each, oldest first, then each other page of the day. None where the browser refuses its storage.
export function unclaimedPages(stores = new OldStores()) {
  try {
    return new SeatPages(Seat.unclaimed, stores.read()).pages.map((page) => ({ key: page.digest, day: page.day.text, ...page.document.fields() }));
  } catch {
    return [];
  }
}

// The domain refused an act of a restore: the pages it would have written wait where they were.
class RestoreRefused extends Error {}

// The unattributed pages written into the account's replica, which must be bound to `account` and stay so: each act
// through the domain's runner, its pages leaving their stores as it commits, a store keeping its entries that do not
// read. An account that changed, or an act the domain refuses, ends the restore with the pages not yet written where they
// were. Answers how many pages were restored: none where none waited any longer.
export async function restoreUnclaimedPages(account, { engine = syncSession.engine, stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  const restored = new Set();
  const tell = (outcome) => track('journal_unclaimed', { action: 'restore', outcome, pages: countBucket(restored.size) });
  try {
    const binding = engine.activeBinding();
    const { state, account: bound } = engine.device.activeReplica.meta;
    if (state !== 'bound' || bound !== account) throw new ReplicaChanged();
    const runner = runnerOf(engine);
    for (const act of new SeatPages(Seat.unclaimed, stores.read()).restoring(PAGES_PER_ACT)) {
      const outcome = await runner.runComposed(act.parts, { binding });
      if (outcome.kind === 'refused') throw new RestoreRefused();
      for (const page of stores.settle(Seat.unclaimed, new Set(act.pages.map((each) => each.digest)))) {
        if (!page.copy) restored.add(page.digest);
      }
    }
  } catch (error) {
    if (error instanceof ReplicaChanged) tell('replica_changed');
    else if (error instanceof RestoreRefused) tell('refused');
    else {
      report('journal-restore', 'restore', error);
      tell('failed');
    }
    throw error;
  }
  tell(restored.size > 0 ? 'ok' : 'none');
  return restored.size;
}

// The unattributed pages Settings listed (`unclaimedPages`, by their keys) deleted from this browser's storage, and no
// other: a page that arrived since waits, as do the entries that do not read. Nothing is written to the engine. Answers
// how many of the listed pages went.
export function dropUnclaimedPages(listed, { stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  try {
    const gone = stores.settle(Seat.unclaimed, new Set(listed)).filter((page) => !page.copy);
    const dropped = new Set(gone.map((page) => page.digest)).size;
    track('journal_unclaimed', { action: 'discard', outcome: dropped > 0 ? 'ok' : 'none', pages: countBucket(dropped) });
    return dropped;
  } catch (error) {
    report('journal-discard', 'discard', error);
    track('journal_unclaimed', { action: 'discard', outcome: 'failed', pages: countBucket(0) });
    throw error;
  }
}
