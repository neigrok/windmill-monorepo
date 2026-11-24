// web-device-parity §5: what the journal's bundle before the engine kept in this browser's storage, carried into the
// engine's replica through the domain's actions (domain/carry.js). A seat's pages go only into the replica they belong
// to, while it is active: an account's (`wm.journal.*.u.<id>`) into that account's bound replica, those written signed
// out (`.anon`) into the anon replica. A run pins the engine's active binding as it starts, and the engine commits its
// acts only while that binding stands: a sign-in or a sign-out between ends the run with every store whole, and the next
// replica's run carries what is its. A store goes once the ledger in the replica records its pages, and only while it
// holds the bytes that were read. The pages that bundle could not attribute (`.unclaimed`) stay in the browser's storage
// until a signed-in person restores or discards them in Settings.

import { jcs } from '../../../../packages/api-contract/sync/reference/core/jcs.js';
import { ActionRunner, EngineReplica } from '../../platform/domain-kit/runner.js';
import { FixedZone } from '../../platform/domain-kit/time.js';
import { hashText } from '../../platform/sync/core/encoding.js';
import { ReplicaChanged } from '../../platform/sync/engine.js';
import { MemoryStore } from '../../platform/sync/memoryStore.js';
import { syncSession } from '../../platform/sync/session.js';
import { track as trackEvent } from '../../telemetry/beacon.js';
import { countBucket } from '../../telemetry/countBucket.js';
import { captureError } from '../../telemetry/sentry.js';
import { OldStore, Seat, SeatPages } from './domain/carry.js';
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
/** @param {string} operation @param {'read' | 'write' | 'clear' | 'leftovers' | 'restore' | 'discard'} stage @param {any} [error] */
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

  // What is left of `store` once every page `done` names is carried (`OldStore.rest`), while it holds the bytes it was
  // read with; answers whether it changed.
  settle(store, done) {
    const rest = store.rest(done);
    if (rest.kind === 'keep' || this.storage.getItem(store.key) !== store.raw) return false;
    if (rest.kind === 'forget') this.storage.removeItem(store.key);
    else this.storage.setItem(store.key, rest.raw);
    return true;
  }

  // `store` taken whole, entries that do not read included, while it holds the bytes it was read with.
  discard(store) {
    if (this.storage.getItem(store.key) !== store.raw) return false;
    this.storage.removeItem(store.key);
    return true;
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
  }

  // A run at once, and again whenever another binding becomes active: a sign-in or a sign-out, once its question is
  // answered. Answers once the first run ends, and never rejects, so the engine opens whatever the stores hold. A device
  // held in memory carries nothing: the stores would outlive the only copy of their pages.
  start() {
    if (this.engine.store instanceof MemoryStore) return Promise.resolve();
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

  async carry() {
    const { engine } = this;
    const binding = engine.activeBinding();
    const seat = Seat.ofReplica(engine.device.activeReplica.meta);
    if (seat === null) return;
    await this.returnLeftovers();
    const stores = this.readStores();
    const pages = new SeatPages(seat, stores);
    if (pages.stores.length === 0) return;
    const runner = runnerOf(engine);
    let written = 0;
    try {
      for (const parts of pages.carrying(PAGES_PER_ACT)) {
        const outcome = await runner.runComposed(parts, { binding });
        if (outcome.kind === 'refused') throw new Error('the journal carry was refused');
        if (outcome.kind === 'committed') written += outcome.results.filter((result) => WROTE.has(result)).length;
      }
    } catch (error) {
      if (error instanceof ReplicaChanged) return;
      this.report('journal-migration', 'write', error);
      this.tell(seat, 'failed', pages.pages.length);
      return;
    }
    if (engine.activeBinding() !== binding) return;
    let cleared = 0;
    for (const store of pages.stores) {
      try { if (this.stores.settle(store, () => true)) cleared += store.pages.length; }
      catch (error) { this.report('journal-migration', 'clear', error); }
    }
    if (written > 0) this.tell(seat, 'carried', written);
    else if (cleared > 0) this.tell(seat, 'cleared', cleared);
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

// The pages this browser kept that the bundle before the engine could not attribute, as Settings lists them: a day
// each, oldest first, then each other page of the day. None where the browser refuses its storage.
export function unclaimedPages(stores = new OldStores()) {
  try {
    return new SeatPages(Seat.unclaimed, stores.read()).pages.map((page) => ({ key: page.digest, day: page.day.text, ...page.document.fields() }));
  } catch {
    return [];
  }
}

// The unattributed pages written into the account's replica, which must be bound to `account` and stay so: each act
// through the domain's runner, the stores going once they are written, each while it holds the bytes that were read and
// keeping only its entries that do not read. Answers how many pages were restored: none where none waited any longer.
export async function restoreUnclaimedPages(account, { engine = syncSession.engine, stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  try {
    const binding = engine.activeBinding();
    const { state, account: bound } = engine.device.activeReplica.meta;
    if (state !== 'bound' || bound !== account) throw new Error('the account changed before the pages were restored');
    const unclaimed = new SeatPages(Seat.unclaimed, stores.read());
    const runner = runnerOf(engine);
    for (const parts of unclaimed.restoring(PAGES_PER_ACT)) {
      const outcome = await runner.runComposed(parts, { binding });
      if (outcome.kind === 'refused') throw new Error('the restore was refused');
    }
    const settled = unclaimed.stores.filter((store) => stores.settle(store, () => true));
    const restored = settled.length > 0 ? unclaimed.pages.length : 0;
    track('journal_unclaimed', { action: 'restore', outcome: restored > 0 ? 'ok' : 'none', pages: countBucket(restored) });
    return restored;
  } catch (error) {
    report('journal-restore', 'restore', error);
    track('journal_unclaimed', { action: 'restore', outcome: 'failed', pages: countBucket(0) });
    throw error;
  }
}

// The unattributed pages deleted from this browser's storage, each store while it holds the bytes that were read,
// keeping only its entries that do not read; nothing is written to the engine. Answers how many pages went.
export function dropUnclaimedPages({ stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  try {
    const unclaimed = new SeatPages(Seat.unclaimed, stores.read());
    const settled = unclaimed.stores.filter((store) => stores.settle(store, () => true));
    const dropped = settled.length > 0 ? unclaimed.pages.length : 0;
    track('journal_unclaimed', { action: 'discard', outcome: dropped > 0 ? 'ok' : 'none', pages: countBucket(dropped) });
    return dropped;
  } catch (error) {
    report('journal-discard', 'discard', error);
    track('journal_unclaimed', { action: 'discard', outcome: 'failed', pages: countBucket(0) });
    throw error;
  }
}

// A sign-out's Discard or the account's closure took the account's replica, and with it what the carry wrote there: the
// account's stores go too, so pages the person discarded do not return at the account's next sign-in. A Keep keeps the
// replica, and the stores wait with it.
export function forgetSeat({ previous = null } = {}, { engine = syncSession.engine, stores = new OldStores(), track = trackEvent, report = reportFailure } = {}) {
  if (previous === null || !engine || engine.closed || engine.hasReplicaOf(previous)) return;
  try {
    const seat = Seat.of(previous);
    const discarded = stores.read().filter((store) => store.seat.equals(seat) && stores.discard(store));
    const pages = discarded.reduce((sum, store) => sum + store.pages.length, 0);
    if (discarded.length > 0) track('journal_carry', { seat: seat.kind, outcome: 'discarded', pages: countBucket(pages) });
  } catch (error) {
    report('journal-migration', 'clear', error);
  }
}
