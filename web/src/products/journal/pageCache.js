// The pages as this browser holds them — the web twin of
// apps/ios/WindmillKit/Sources/WindmillJournal/PageCache.swift, and the half journal-web never had.
// The device is a real place a page can live, not a cache in front of the server: writing works
// signed out and offline because of this file, and signing in CLAIMS what is here rather than
// gating it (journal's auth canon — "claiming, not gating").
//
// MECHANISM. One localStorage key holding every entry as JSON, read once at construction into
// memory and written whole on flush. Roadmap keeps its tree lattice in IndexedDB because a lattice
// is large and two tabs JOIN into one document concurrently; a journal page is prose keyed by day,
// convergence is last-writer-wins on one stamp rather than a merge, and this tier only holds a
// sixty-day window plus whatever is owed — kilobytes. What localStorage buys for that shape is the
// thing IndexedDB cannot: the store opens SYNCHRONOUSLY, so the canvas draws this device's pages on
// the first frame with no await between mount and paint. iOS gets the same property by reading one
// file in init. An unreadable or absent store opens EMPTY rather than throwing — a corrupted blob
// costs the window, never the room.
//
// TWO MARKS PER ENTRY, and they answer different questions:
//   needsPush — this device owes the account this page.
//   read      — this device has SEEN the account's answer for this day.
// Owed AND read is an ordinary offline write: it was made over prose we had in front of us, it
// carries the stamp it was written with, and last-writer-wins settles it. Owed and NOT read is not
// a page yet — it is words this browser is HOLDING for a day whose real page it has never seen —
// and it carries no stamp at all, because a stamp is a claim to have written last and this device
// cannot make that claim about a page it never read. pageStore.js is where a held draft becomes a
// page: it reads the account's day first, joins onto it, and stamps THAT.
//
// So `store` is for stamped pages only and `hold` is for the unstamped draft. They are different
// verbs because they obey different rules — a stamped page races, a held draft simply replaces
// whatever this browser was holding for that day.

import { compareStamps, ZERO_STAMP } from './hlc.js';

const CACHE_KEY = 'wm.journal.pages';

// Private-mode browsers throw on first use rather than on the property, and a Node test run has no
// localStorage at all — both read as "no device tier", never as an exception out of a constructor.
export function deviceStorage(key = CACHE_KEY) {
  try {
    const storage = globalThis.localStorage;
    storage.getItem(key);
    return storage;
  } catch {
    return null;
  }
}

// A day the writer touched at all. A page with a mood and no words was still a day someone showed
// up for, so it counts — and a day nobody touched is drawn as a gap, never counted.
export function isWritten(page) {
  return Boolean(page.body) || page.mood != null || page.energy != null;
}

export function blankPage(day) {
  return { day, body: '', mood: null, energy: null, source: 'typed', stamp: ZERO_STAMP };
}

// The one boundary every foreign page shape crosses: the wire (where an unset scale is 0), an older
// build's blob, another tab's write. Inside this module an unset scale is null and nothing else, so
// "did the writer set a mood" is one comparison everywhere instead of two.
export function normalizePage(raw) {
  return {
    day: String(raw?.day ?? ''),
    body: typeof raw?.body === 'string' ? raw.body : '',
    mood: raw?.mood || null,
    energy: raw?.energy || null,
    source: raw?.source === 'spoken' ? 'spoken' : 'typed',
    stamp: typeof raw?.stamp === 'string' ? raw.stamp : ZERO_STAMP,
  };
}

// Last writer wins, by stamp — the single convergence rule, stated once. Ties go to the page
// already held: an identical stamp means the same write arriving twice, and preferring the
// incumbent keeps a re-read from looking like a change.
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

export class PageCache {
  constructor(storage = deviceStorage(), key = CACHE_KEY) {
    this.storage = storage;
    this.key = key;
    this.entries = new Map(readEntries(storage, key));
  }

  page(day) {
    return this.entries.get(day)?.page ?? null;
  }

  // Whether this device has seen the account's answer for a day. The whole write path turns on it:
  // pageStore.js mints a stamp only where this is true.
  hasRead(day) {
    return this.entries.get(day)?.read === true;
  }

  pages() {
    return [...this.entries.values()].map((entry) => entry.page).sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // Everything this device owes the account — the queue a reconnect or a sign-in drains, oldest
  // first so a backlog replays in the order it was lived. Entries, not pages: the sender has to
  // know whether the day was read before it may stamp one.
  owed() {
    return [...this.entries.values()].filter((entry) => entry.needsPush).sort((a, b) => (a.page.day < b.page.day ? -1 : 1));
  }

  // A stamped page arriving from anywhere — a local write over a day we had read, a range read, a
  // PUT reply. Convergence is decided here exactly as the server decides it, so a page arriving
  // twice by two routes can never flap.
  store(page, { needsPush = false, read = false } = {}) {
    const held = this.entries.get(page.day) ?? null;
    const winner = winnerOf(page, held?.page ?? null);
    // Whether this device still OWES the account a write. A local edit always owes. An arriving
    // remote page settles the debt only by beating what we were holding — if our unsent page is
    // still the winner, it is still unsent.
    const heldSurvived = Boolean(held?.needsPush) && winner === held.page;
    this.entries.set(page.day, {
      page: winner,
      needsPush: needsPush || heldSurvived,
      read: read || Boolean(held?.read),
    });
    return winner;
  }

  // Words for a day this device has never read. Not a page yet: no stamp, no race — it simply
  // replaces what this browser was holding, because two drafts of an unread day are the same
  // writer typing, not two devices disagreeing.
  hold(draft) {
    this.entries.set(draft.day, {
      page: { ...normalizePage(draft), stamp: ZERO_STAMP },
      needsPush: true,
      read: false,
    });
  }

  // The account answered for this day — with a page, or (null) with the fact that it holds none.
  markRead(day, page) {
    const held = this.entries.get(day) ?? null;
    // A day this browser is HOLDING words for belongs to the claim, not to a read: pageStore joins
    // them onto the account's page and sends that. Settling the day here would drop them. The claim
    // always runs before the window read, so this is a guard rather than a path.
    if (held && held.needsPush && !held.read) return;
    const winner = winnerOf(page ?? blankPage(day), held?.page ?? null);
    this.entries.set(day, {
      page: winner,
      needsPush: Boolean(held?.needsPush) && winner === held.page,
      read: true,
    });
  }

  // The account has answered for a write we sent. That is just a remote page arriving, so it goes
  // through the one rule above rather than clearing the debt outright — because by the time a reply
  // lands the writer may already have typed something newer, and THAT page is still owed. Clearing
  // it here would drop the last thing someone typed if the tab closed next.
  markPushed(day, winner) {
    const held = this.entries.get(day) ?? null;
    // Strictly newer, not "at least as new": an acknowledged write usually comes back with the very
    // stamp we sent, and treating that as unsettled would leave every successful write owed forever
    // and re-push it on every reconnect.
    const newerWaiting = Boolean(held?.needsPush) && compareStamps(held.page.stamp, winner.stamp) > 0;
    this.entries.set(day, {
      page: winnerOf(winner, held?.page ?? null),
      needsPush: newerWaiting,
      read: true,
    });
  }

  // Whether the device took the bytes. The answer is the caller's, not a courtesy: a browser that
  // refused the write is not holding anything, and nothing may tell the writer that it is.
  flush() {
    if (!this.storage) return false;
    try {
      // Union by day with what is already on disk. A second tab of the same journal holds its own
      // copy of this map, and a blind write would drop a day it never touched. Days both tabs hold
      // are last-flush-wins, which is what one person typing in two tabs on one day gets anyway.
      const merged = {};
      for (const [day, entry] of readEntries(this.storage, this.key)) merged[day] = entry;
      for (const [day, entry] of this.entries) merged[day] = entry;
      this.storage.setItem(this.key, JSON.stringify(merged));
      return true;
    } catch {
      return false;
    }
  }
}
