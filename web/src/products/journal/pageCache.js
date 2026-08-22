// The pages as this browser holds them — the web twin of
// apps/ios/WindmillKit/Sources/WindmillJournal/PageCache.swift, and the half journal-web never had.
// The device is a real place a page can live, not a cache in front of the server: writing works
// signed out and offline because of this file, and signing in CLAIMS what is here rather than
// gating it (journal's auth canon — "claiming, not gating").
//
// MECHANISM. One localStorage key holding every entry as JSON, read once at construction into
// memory and written whole on flush. Roadmap keeps its tree lattice in IndexedDB because a lattice
// is large and two tabs JOIN into one document concurrently; a journal page is prose keyed by day,
// convergence is last-writer-wins on one stamp rather than a merge, and what this tier keeps on
// disk is a few months plus whatever is owed — kilobytes (see RETAIN_DAYS). What localStorage buys
// for that shape is the thing IndexedDB cannot: the store opens SYNCHRONOUSLY, so the canvas draws
// this device's pages on the first frame with no await between mount and paint. iOS gets the same
// property by reading one file in init. An unreadable or absent store opens EMPTY rather than
// throwing — a corrupted blob costs the window, never the room.
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
//
// ONE SCOPE PER ACCOUNT, AND A SCOPE IS A KEY. Pages belong to the account that read or wrote them,
// so the account is IN the key: `wm.journal.pages.u.<userId>`, or `wm.journal.pages.anon` for the
// writing done while nobody is signed in. Until 2026-08-22 every page this browser had ever seen
// lived under one key with no owner in it, and the next person to sign in on the same browser was
// shown the previous person's journal and PUT it into their own account on the first keystroke.
// A filter would have fixed that only where somebody remembered to write one; a key fixes it
// everywhere, because a cache opened for one account never READS another account's bytes at all —
// not after a crashed tab, not on a build that predates the hook, not on a path nobody thought of.
//
// Two things cross a scope, and NEITHER crosses on its own:
//   · the anonymous claim — words written while nobody was signed in follow the person who signs
//     in, unstamped, joined onto their page (anonymousDrafts, below);
//   · the QUARANTINE — the unsent pages recovered from the old unscoped store, which no account may
//     be given without a person saying so out loud (unclaimedPages, below).

import { compareStamps, ZERO_STAMP } from './hlc.js';

// The unscoped store every browser that ran journal before 2026-08-22 still holds. Read once, on
// the first open under the new code, and retired — never written again. See retireLegacyStore().
const LEGACY_KEY = 'wm.journal.pages';
const ANON_KEY = 'wm.journal.pages.anon';
// Where the unsent pages out of the legacy store wait. No scope ever opens this key: nothing here
// is drawn on a canvas, indexed by search or sent anywhere until a signed-in person restores it.
const UNCLAIMED_KEY = 'wm.journal.pages.unclaimed';

// The scope is a user id, or null for "nobody is signed in". Nothing may open the device tier
// without naming one, which is why there is no default.
export function keyForScope(account) {
  return account ? `wm.journal.pages.u.${account}` : ANON_KEY;
}

// How many days of read pages survive a reload. Reaching further back than the canvas's window
// (pageStore.js) pulls months — sometimes years — into memory, and every one of them belongs on
// screen. None of them belongs in the durable store: localStorage is the WRITING tier here, the
// place a page lives when there is no network and no account, and history crowding it out would
// eventually cost a write. So a flush keeps everything OWED, whatever its age, plus the newest
// RETAIN_DAYS entries; anything older is read from the account again on the next open, which is
// where it came from. Two windows of calendar, blank days included.
const RETAIN_DAYS = 120;

// Private-mode browsers throw on first use rather than on the property, and a Node test run has no
// localStorage at all — both read as "no device tier", never as an exception out of a constructor.
export function deviceStorage(key = ANON_KEY) {
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

// The unscoped blob, dealt with once and for all on the first open under the new code — and dealt
// with by QUARANTINE, because there is no honest way to attribute it. An OWED entry in it is unsent
// prose, but "unsent" says nothing about who wrote it: it is as likely a signed-in person's page
// written on a plane as a signed-out visitor's draft. Moving it into the anonymous scope would hand
// it to whoever signs in next — which is JOURNAL-1 again, with the migration doing the leaking, and
// it was proven end to end in a browser before this was written.
//
// So the unsent pages go to a key NO scope opens, and stay there until a signed-in person restores
// them by hand (settings · Your journal). Nothing paints them, nothing indexes them, and no PUT can
// carry them until somebody says yes. Losing nobody's words is still the constraint —
// quarantined-and-visible beats deleted, and deleted beats delivered to a stranger.
//
// Everything else in the blob is a cached copy of some account's server window. The key never said
// whose, so it cannot be attributed now either, and the safe reading of an unattributable cache is
// that it is NOT the arriving account's — it is dropped. Nothing is lost by that: a read page is
// one range read away from the account that owns it, which is where it came from in the first place.
//
// A storage that refuses the write keeps the legacy key, so the next open tries again rather than
// dropping the unsent pages on the floor.
function retireLegacyStore(storage) {
  try {
    if (storage.getItem(LEGACY_KEY) === null) return;
    const quarantined = {};
    for (const [day, entry] of readEntries(storage, UNCLAIMED_KEY)) quarantined[day] = entry;
    for (const [day, entry] of readEntries(storage, LEGACY_KEY)) {
      if (!entry.needsPush || quarantined[day]) continue;
      quarantined[day] = { page: { ...entry.page, stamp: ZERO_STAMP }, needsPush: true, read: false };
    }
    storage.setItem(UNCLAIMED_KEY, JSON.stringify(quarantined));
    storage.removeItem(LEGACY_KEY);
  } catch {
    // No device tier, or it refused: the legacy key stays exactly as it is and the next open retries.
  }
}

// What is waiting in quarantine, oldest first — for the one surface that offers it back
// (settings/YourJournalSection.jsx) and for the restore that follows a person's yes. Reading it is
// not claiming it: these pages belong to whoever wrote them on this browser before scoping existed,
// and the product's only honest move is to show them and ask.
export function unclaimedPages(storage = deviceStorage()) {
  if (!storage) return [];
  return readEntries(storage, UNCLAIMED_KEY)
    .map(([, entry]) => ({ ...entry.page, stamp: ZERO_STAMP }))
    .sort((left, right) => (left.day < right.day ? -1 : 1));
}

// Emptied on a restore that landed, and on a discard — the two ends of the one question, both of
// them a person's own answer.
export function dropUnclaimedPages(storage = deviceStorage()) {
  try { storage.removeItem(UNCLAIMED_KEY); } catch { /* no device tier — nothing was on it to drop */ }
}

// The claim, and the only thing that ever crosses a scope: words written while nobody was signed in
// belong to the person who signs in here — the anonymous-first door's whole promise (auth canon:
// "claiming, not gating"). Only OWED drafts travel, and they travel unstamped, because a stamp is a
// claim to have written last about an account's page and no page written signed-out has ever read
// one. pageStore joins them onto the arriving account's day; nothing races.
export function anonymousDrafts(storage = deviceStorage()) {
  if (!storage) return [];
  return readEntries(storage, ANON_KEY)
    .filter(([, entry]) => entry.needsPush)
    .map(([, entry]) => ({ ...entry.page, stamp: ZERO_STAMP }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Called only once the account's scope has TAKEN the drafts and flushed them — see
// pageStore.claimAnonymousDrafts.
// Deleting first and flushing second would lose the writing of anyone whose device refused the
// bytes at exactly that moment.
export function dropAnonymousScope(storage = deviceStorage()) {
  try { storage.removeItem(ANON_KEY); } catch { /* no device tier — nothing was on it to drop */ }
}

export class PageCache {
  constructor(account, storage = deviceStorage()) {
    this.storage = storage;
    this.key = keyForScope(account ?? null);
    if (storage) retireLegacyStore(storage);
    this.entries = new Map(readEntries(storage, this.key));
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
    // The account answering "I hold nothing here" arrives as a blank page carrying ZERO_STAMP, and
    // ZERO_STAMP loses every race — so a stamped entry already in this map survives an empty read.
    // That is right BECAUSE of the scope: every entry in this map was read or written by the very
    // account that just answered, so the survivor is its own newer local write, never a stranger's
    // page. Under the one unscoped key this rule was JOURNAL-1's second half: the previous user's
    // stamped pages beat the arriving account's own empty read and were drawn as theirs.
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
      // The retention line, applied to the union rather than to this tab's half, so two tabs that
      // have reached back to different depths still agree on what the disk holds.
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
