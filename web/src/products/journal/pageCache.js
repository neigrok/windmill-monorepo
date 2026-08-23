// One localStorage key per scope, read whole at construction and written whole on flush; an unreadable
// store opens empty. Two marks per entry: `needsPush` — this device owes the account this page; `read` —
// this device has seen the account's answer for that day. Owed and not read carries no stamp, because a
// stamp claims to have written last: `store` takes stamped pages, `hold` the unstamped one.
// The scope is the key — `wm.journal.v2.pages.u.<userId>`, or `wm.journal.v2.pages.anon` signed out — and a
// cache opened for one account never reads another account's bytes.

import { compareStamps, ZERO_STAMP } from './hlc.js';

// v2: the scales became 0..10 with null for unanswered, so every v1 entry holds a `0` that used to mean
// "unset" and would now be read as a real zero. The version lives in the key, and every v1 key is read
// once on open, migrated onto the new scales, folded into its v2 successor and removed. The bump is not
// a licence to drop the bytes: a scoped store is the only home of writes that never reached the server.
const LEGACY_KEY = 'wm.journal.pages';
const V1_UNCLAIMED_KEY = 'wm.journal.pages.unclaimed';
const ANON_KEY = 'wm.journal.v2.pages.anon';
// No scope opens this key: nothing here is drawn, indexed or sent until a signed-in person restores it.
const UNCLAIMED_KEY = 'wm.journal.v2.pages.unclaimed';

export function keyForScope(account) {
  return account ? `wm.journal.v2.pages.u.${account}` : ANON_KEY;
}

function version1KeyForScope(account) {
  return account ? `wm.journal.pages.u.${account}` : 'wm.journal.pages.anon';
}

// A flush keeps everything owed whatever its age, plus the newest RETAIN_DAYS entries.
const RETAIN_DAYS = 120;

// Private-mode browsers throw on first use and Node has no localStorage: both read as no device tier.
export function deviceStorage(key = ANON_KEY) {
  try {
    const storage = globalThis.localStorage;
    storage.getItem(key);
    return storage;
  } catch {
    return null;
  }
}

// A day the writer touched at all: a mood with no words counts.
export function isWritten(page) {
  return Boolean(page.body) || page.mood != null || page.energy != null;
}

export function blankPage(day) {
  return { day, body: '', mood: null, energy: null, source: 'typed', stamp: ZERO_STAMP };
}

// A scale is 0..10 or null, on the wire and in here. 0 means zero; anything outside the range, and
// anything that is not a whole number, narrows to unanswered rather than being believed.
function score(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= 10 ? raw : null;
}

export function normalizePage(raw) {
  return {
    day: String(raw?.day ?? ''),
    body: typeof raw?.body === 'string' ? raw.body : '',
    mood: score(raw?.mood),
    energy: score(raw?.energy),
    source: raw?.source === 'spoken' ? 'spoken' : 'typed',
    stamp: typeof raw?.stamp === 'string' ? raw.stamp : ZERO_STAMP,
  };
}

// Last writer wins by stamp; ties go to the page already held.
export function winnerOf(incoming, held) {
  if (!held) return incoming;
  return compareStamps(incoming.stamp, held.stamp) > 0 ? incoming : held;
}

function readEntries(storage, key) {
  if (!storage) return [];
  try {
    const stored = JSON.parse(storage.getItem(key));
    if (!stored || typeof stored !== 'object') return [];
    return Object.entries(stored)
      .filter(([day, entry]) => day && entry && entry.page)
      .map(([day, entry]) => [day, {
        page: { ...normalizePage(entry.page), day },
        needsPush: Boolean(entry.needsPush),
        read: Boolean(entry.read),
      }]);
  } catch {
    return [];
  }
}

// The same mapping the server migration runs (spec §8.4): v1's five mood steps land on the odd positions
// of the new ramp, v1's three energy steps on the centre of each third, and both zeroes on unanswered —
// a v1 zero meant "unset" and must never survive as a recorded zero.
const V1_ENERGY = { 1: 2, 2: 5, 3: 8 };

function readVersion1Entries(storage, key) {
  return readEntries(storage, key).map(([day, entry]) => [day, {
    ...entry,
    page: {
      ...entry.page,
      mood: entry.page.mood >= 1 && entry.page.mood <= 5 ? 2 * entry.page.mood - 1 : null,
      energy: V1_ENERGY[entry.page.energy] ?? null,
    },
  }]);
}

// Owed entries from the pre-scoping store go to quarantine: "unsent" says nothing about who wrote them,
// and everything else there is an unattributable cached copy and is dropped. The v1 quarantine comes over
// whole — it is the one store designed never to lose a page. A storage that refuses the write keeps both
// v1 keys and the next open retries.
function retireVersion1Stores(storage) {
  try {
    const sources = [LEGACY_KEY, V1_UNCLAIMED_KEY].filter((key) => storage.getItem(key) !== null);
    if (sources.length === 0) return;
    const quarantined = {};
    for (const [day, entry] of readEntries(storage, UNCLAIMED_KEY)) quarantined[day] = entry;
    for (const source of sources) {
      for (const [day, entry] of readVersion1Entries(storage, source)) {
        if (quarantined[day] || (!entry.needsPush && source !== V1_UNCLAIMED_KEY)) continue;
        quarantined[day] = { page: { ...entry.page, stamp: ZERO_STAMP }, needsPush: true, read: false };
      }
    }
    storage.setItem(UNCLAIMED_KEY, JSON.stringify(quarantined));
    for (const source of sources) storage.removeItem(source);
  } catch {
    // Refused: the v1 keys stay as they are and the next open retries.
  }
}

// What is waiting in quarantine, oldest first. Reading is not claiming.
export function unclaimedPages(storage = deviceStorage()) {
  if (!storage) return [];
  return readEntries(storage, UNCLAIMED_KEY)
    .map(([, entry]) => ({ ...entry.page, stamp: ZERO_STAMP }))
    .sort((left, right) => (left.day < right.day ? -1 : 1));
}

// Emptied on a restore that landed, and on a discard.
export function dropUnclaimedPages(storage = deviceStorage()) {
  try { storage.removeItem(UNCLAIMED_KEY); } catch { /* no device tier */ }
}

// Only owed drafts travel, and unstamped: nothing written signed out has read an account's page.
export function anonymousDrafts(storage = deviceStorage()) {
  if (!storage) return [];
  return readEntries(storage, ANON_KEY)
    .filter(([, entry]) => entry.needsPush)
    .map(([, entry]) => ({ ...entry.page, stamp: ZERO_STAMP }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Called only once the account's scope has taken the drafts and flushed them.
export function dropAnonymousScope(storage = deviceStorage()) {
  try { storage.removeItem(ANON_KEY); } catch { /* no device tier */ }
}

export class PageCache {
  constructor(account, storage = deviceStorage()) {
    this.storage = storage;
    this.key = keyForScope(account ?? null);
    if (storage) retireVersion1Stores(storage);
    this.entries = new Map(readEntries(storage, this.key));
    if (storage) this.adoptVersion1Scope(account ?? null);
  }

  // This scope's own bytes under the unversioned key: migrated onto the new scales and folded in, never
  // dropped, because a scoped store is also the sole home of writes that never reached the server. The
  // key is removed only once the v2 key has taken them, so a refused write is retried on the next open.
  adoptVersion1Scope(account) {
    const source = version1KeyForScope(account);
    try {
      if (this.storage.getItem(source) === null) return;
      for (const [, entry] of readVersion1Entries(this.storage, source)) {
        this.store(entry.page, { needsPush: entry.needsPush, read: entry.read });
      }
      if (this.flush()) this.storage.removeItem(source);
    } catch {
      // Refused: the v1 key stays as it is and the next open retries.
    }
  }

  page(day) {
    return this.entries.get(day)?.page ?? null;
  }

  // Whether this device has seen the account's answer for a day; a stamp is minted only where true.
  hasRead(day) {
    return this.entries.get(day)?.read === true;
  }

  pages() {
    return [...this.entries.values()].map((entry) => entry.page).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // Everything owed, oldest first. Entries, not pages: the sender must know whether the day was read.
  owed() {
    return [...this.entries.values()].filter((entry) => entry.needsPush).sort((a, b) => (a.page.day < b.page.day ? -1 : 1));
  }

  // A stamped page arriving from anywhere; convergence is decided as the server decides it.
  store(page, { needsPush = false, read = false } = {}) {
    const held = this.entries.get(page.day) ?? null;
    const winner = winnerOf(page, held?.page ?? null);
    // An arriving page settles the debt only by beating what was held.
    const heldSurvived = Boolean(held?.needsPush) && winner === held.page;
    this.entries.set(page.day, {
      page: winner,
      needsPush: needsPush || heldSurvived,
      read: read || Boolean(held?.read),
    });
    return winner;
  }

  // A day this device has never read: no stamp, no race — it replaces what was held.
  hold(draft) {
    this.entries.set(draft.day, {
      page: { ...normalizePage(draft), stamp: ZERO_STAMP },
      needsPush: true,
      read: false,
    });
  }

  // A null page means the account holds none for that day.
  markRead(day, page) {
    const held = this.entries.get(day) ?? null;
    // A day this browser holds words for belongs to the claim, not to a read.
    if (held && held.needsPush && !held.read) return;
    // "Nothing here" arrives as a blank page at ZERO_STAMP, which loses every race, so a stamped entry
    // survives an empty read.
    const winner = winnerOf(page ?? blankPage(day), held?.page ?? null);
    this.entries.set(day, {
      page: winner,
      needsPush: Boolean(held?.needsPush) && winner === held.page,
      read: true,
    });
  }

  // A reply is a remote page arriving, not a debt cleared: newer typing may still be owed.
  markPushed(day, winner) {
    const held = this.entries.get(day) ?? null;
    // Strictly newer, not "at least as new": an acknowledged write comes back with the stamp we sent.
    const newerWaiting = Boolean(held?.needsPush) && compareStamps(held.page.stamp, winner.stamp) > 0;
    this.entries.set(day, {
      page: winnerOf(winner, held?.page ?? null),
      needsPush: newerWaiting,
      read: true,
    });
  }

  // Answers whether the device took the bytes.
  flush() {
    if (!this.storage) return false;
    try {
      // Union by day with what is on disk: a second tab holds its own copy and a blind write would drop
      // a day it never touched. Days both tabs hold are last-flush-wins.
      const merged = {};
      for (const [day, entry] of readEntries(this.storage, this.key)) merged[day] = entry;
      for (const [day, entry] of this.entries) merged[day] = entry;
      // The retention line applies to the union, so two tabs at different depths agree.
      const days = Object.keys(merged).sort();
      const oldestKept = days[Math.max(0, days.length - RETAIN_DAYS)] ?? '';
      const kept = {};
      for (const day of days) if (day >= oldestKept || merged[day].needsPush) kept[day] = merged[day];
      this.storage.setItem(this.key, JSON.stringify(kept));
      return true;
    } catch {
      return false;
    }
  }
}
