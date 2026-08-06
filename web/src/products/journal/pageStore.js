// The canvas's data — the web twin of apps/ios/WindmillKit/Sources/WindmillJournal/PageStore.swift,
// and the whole of what usePages.js used to hold. It is a plain class rather than a hook body so
// the rules below can be driven directly, with a fake cache and a fake api, by tests that do not
// need a browser: this is the one file in journal where the writing meets the network, the clock
// and the device, and every rule in it is a way prose has actually been lost.
//
// THE ORDER OF A WRITE NEVER VARIES, and it is iOS's: the words land on the device FIRST, and the
// network is what happens next, or later, or on sign-in. Nothing is ever held in memory waiting for
// a round trip to decide whether it counts.
//
// A READ THAT FAILED IS NOT AN EMPTY ACCOUNT. `readState` tells loading, ready, device and failed
// apart, and `firstRun` is computed only from a read that landed — a writer with two years of pages
// opening the journal on a plane must never be shown a virgin canvas.
//
// A STAMP IS ONLY EVER MINTED AGAINST A PAGE THIS DEVICE HAS READ. See persist() and
// joinOntoAccount() below; that rule is what makes the two above matter.
//
// A REPLY IS A RECEIPT FOR ONE WRITE, NEVER FOR EVERY WRITE — the cache's markPushed keeps a newer
// unsent draft owed, so a slow reply cannot swallow the last thing someone typed.

import { journalApi } from './journalApi.js';
import { PageCache, isWritten, normalizePage } from './pageCache.js';
import { localDay, daysBefore, mintStamp } from './hlc.js';

export const WINDOW_DAYS = 60;
export const SAVE_DEBOUNCE = 800;
export const RETRY_DELAY = 4000;

function daysBetween(from, to) {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// The inclusive run of local days [from, to], oldest first — the calendar the canvas draws,
// gaps and all.
export function span(from, to) {
  const out = [];
  for (let k = daysBetween(from, to); k >= 0; k--) out.push(daysBefore(to, k));
  return out;
}

// Two bodies for one day, neither of which may be destroyed: the account's prose first, the words
// written on this device after it, one blank line between. This is what happens instead of a race
// whenever a day was written here before its real page could be read — a signed-out page being
// claimed, or a page typed while the window read was failing. Deterministic, and it never asks the
// writer a question they cannot answer.
export function joinBodies(account, here) {
  if (!account.trim()) return here;
  if (!here.trim()) return account;
  if (here.includes(account.trim())) return here;
  return `${account.replace(/\s+$/, '')}\n\n${here.replace(/^\s+/, '')}`;
}

function wireOf(page) {
  return { body: page.body, mood: page.mood, energy: page.energy, source: page.source, stamp: page.stamp };
}

export class PageStore {
  constructor({
    cache = new PageCache(),
    api = journalApi,
    mint = mintStamp,
    today = localDay(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.cache = cache;
    this.api = api;
    this.mint = mint;
    this.today = today;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.history = [];                                    // [{date, body, mood, energy, written}], oldest→newest
    this.draft = { body: '', mood: null, energy: null };   // today, the live draft
    this.readState = 'loading';                            // 'loading' | 'ready' | 'device' | 'failed'
    this.saveState = 'idle';                               // 'idle' | 'saved' | 'device' | 'offline' | 'unsaved'
    this.saveTick = 0;                                     // bumps once per write, so the note re-fades
    this.signedIn = false;
    this.touched = false;                                  // the writer typed before the window landed
    this.savePending = false;
    this.saveTimer = null;
    this.retryTimer = null;
    this.syncing = false;
    this.disposed = false;

    this.listeners = new Set();
    this.snapshot = this.buildSnapshot();
    this.subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => this.snapshot;
  }

  // Nothing written, ever — the first-run surface. Computed rather than stored so no code path can
  // leave it true, and computed only from a read that LANDED: a failed read knows nothing about
  // whether this account is new, and must never be allowed to say that it is.
  isFirstRun() {
    if (this.readState !== 'ready' && this.readState !== 'device') return false;
    return this.history.length === 0
      && this.draft.body.trim() === '' && this.draft.mood == null && this.draft.energy == null;
  }

  buildSnapshot() {
    return {
      today: this.today,
      history: this.history,
      loading: this.readState === 'loading',
      readState: this.readState,
      firstRun: this.isFirstRun(),
      body: this.draft.body,
      mood: this.draft.mood,
      energy: this.draft.energy,
      saveState: this.saveState,
      saveTick: this.saveTick,
    };
  }

  emit() {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  // Called on mount and on every change of who is signed in. Draws from the device first and always
  // — a canvas that waited for a network round trip would be a cursor that waits.
  async connect(signedIn) {
    // Connecting is what puts the store back in service, so dispose() is a pause rather than a
    // death: React StrictMode mounts, tears down and re-mounts the canvas on the SAME store, and a
    // one-way flag would leave the second life unable to read anything, in dev only.
    this.disposed = false;
    this.signedIn = signedIn;
    this.drawFromCache();
    if (!signedIn) {
      // Nobody is signed in, so there is no account to read from and nothing to be offline from:
      // this device IS the record, and everything held here is claimed the moment someone signs in.
      this.readState = 'device';
      if (this.cache.owed().length) this.saveState = 'device';
      this.emit();
      return;
    }
    // A ghost who just signed in is no longer a writer whose device is the whole record, and until
    // the account answers nobody knows what it holds — least of all whether it is new.
    if (this.readState === 'device') this.readState = 'loading';
    this.emit();
    await this.sync();
  }

  // Everything the account and this device owe each other, in the one order that is safe: what is
  // owed goes UP first, because the window read is what settles a day as read — and a day settled
  // before its held words were joined onto it would look like an ordinary page to write over.
  async sync() {
    if (!this.signedIn || this.disposed || this.syncing) return;
    this.syncing = true;
    try {
      if (!(await this.pushWhatIsOwed())) return;
      await this.loadWindow();
    } finally {
      this.syncing = false;
    }
  }

  // The claim (auth canon: adoption is additive) and the reconnect drain are one walk — everything
  // this device owes, oldest first, so a backlog replays in the order it was lived. It stops at the
  // first failure: order is the point, and a retry is already scheduled.
  async pushWhatIsOwed() {
    for (const entry of this.cache.owed()) {
      const resolved = entry.read
        ? { sent: entry.page, recovered: null }
        : await this.joinOntoAccount(entry);
      if (!resolved) { this.cache.flush(); this.settle('offline'); this.scheduleRetry(); return false; }

      let winner;
      try {
        winner = normalizePage(await this.api.putPage(resolved.sent.day, wireOf(resolved.sent)));
      } catch {
        this.cache.flush();
        this.settle('offline');
        this.scheduleRetry();
        return false;
      }
      this.cache.markPushed(resolved.sent.day, winner);
      this.settleDraft(entry, resolved, winner);
    }
    this.cache.flush();
    return true;
  }

  // Words this browser held for a day it had never read. The account's page for that day is fetched
  // FIRST — that read is what earns the right to a stamp — and the two are JOINED rather than
  // raced. Without this, a stamp minted now beats this morning's real page under the rule
  // backend/products/journal/domain/Page.h states outright, and prose that exists is destroyed.
  async joinOntoAccount(entry) {
    let held;
    try {
      held = await this.api.page(entry.page.day);
    } catch {
      return null;
    }
    const recovered = held ? normalizePage(held) : null;
    return {
      recovered,
      sent: {
        day: entry.page.day,
        body: joinBodies(recovered?.body ?? '', entry.page.body),
        mood: entry.page.mood ?? recovered?.mood ?? null,
        energy: entry.page.energy ?? recovered?.energy ?? null,
        source: entry.page.source,
        // MINTED HERE, and this is the only other place a stamp is minted: the account's page for
        // this day is in hand, so this write is made over prose we have read.
        stamp: this.mint(),
      },
    };
  }

  // Adopt what the account settled on, but only for the fields the writer has not moved since —
  // otherwise a reply landing mid-sentence overwrites the sentence they kept typing. When they HAVE
  // moved and the day had been held unread, their newer words are joined onto the recovered page by
  // the same rule that produced the send, and saved: never raced against prose they never saw.
  settleDraft(entry, resolved, winner) {
    if (entry.page.day !== this.today) return;
    const bodyMoved = this.draft.body !== entry.page.body;
    this.draft = {
      body: bodyMoved ? this.draft.body : winner.body,
      mood: this.draft.mood === entry.page.mood ? winner.mood : this.draft.mood,
      energy: this.draft.energy === entry.page.energy ? winner.energy : this.draft.energy,
    };
    if (bodyMoved && resolved.recovered) {
      this.draft = { ...this.draft, body: joinBodies(resolved.recovered.body, this.draft.body) };
      this.scheduleSave(0);
    }
    this.emit();
  }

  async loadWindow() {
    const from = daysBefore(this.today, WINDOW_DAYS);
    let pages;
    try {
      pages = await this.api.range(from, this.today);
    } catch {
      // A read that failed is not an empty account. Say so, keep drawing what the device holds, and
      // leave every day in the window UNREAD so nothing can be written over it.
      this.readState = 'failed';
      if (this.cache.owed().length) this.saveState = 'offline';
      this.scheduleRetry();
      this.emit();
      return;
    }
    this.absorb(from, this.today, pages);
    this.readState = 'ready';
    this.drawFromCache();
  }

  // Reach further back than the initial window so a search hit or an echo older than the canvas can
  // still be flown to. A secondary read: it never decides readState, and a failure is a no-op.
  async extendTo(date) {
    const earliest = this.history.length ? this.history[0].date : daysBefore(this.today, 1);
    if (!date || date >= earliest) return;
    const to = daysBefore(earliest, 1);
    let pages;
    try {
      pages = await this.api.range(date, to);
    } catch {
      return;
    }
    this.absorb(date, to, pages);
    this.drawFromCache();
  }

  // A window the account answered for: every day in it is now read — the ones it named, and the
  // ones it did not, which is the account saying it holds nothing there.
  absorb(from, to, pages) {
    const byDay = new Map(pages.map((page) => [page.day, normalizePage(page)]));
    for (const day of span(from, to)) this.cache.markRead(day, byDay.get(day) ?? null);
    this.cache.flush();
  }

  type(body) {
    this.touched = true;
    this.savePending = true;
    this.draft = { ...this.draft, body };
    this.emit();
    this.scheduleSave(SAVE_DEBOUNCE);
  }

  // Tapping the step you are on clears it: the scales are optional always, so every value must have
  // a way back to unset. A tap writes immediately — there is nothing to debounce.
  tap(field, step) {
    this.touched = true;
    this.savePending = true;
    this.draft = { ...this.draft, [field]: this.draft[field] === step ? null : step };
    this.emit();
    return this.scheduleSave(0);
  }

  scheduleSave(delay) {
    this.clearTimer(this.saveTimer);
    if (delay <= 0) {
      this.saveTimer = null;
      return this.persist();
    }
    this.saveTimer = this.setTimer(() => { this.saveTimer = null; return this.persist(); }, delay);
    return undefined;
  }

  async persist() {
    this.savePending = false;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const day = this.today;
    const draft = this.draft;

    // THE STAMP RULE, at the one place a write is born. A stamp is a claim to have written LAST —
    // backend/products/journal/domain/Page.h resolves two writers on the greater stamp — and this
    // device may only make that claim about a page it has actually read. A day it has not read
    // (nobody signed in, or the window read failed) is HELD here instead: unstamped, unsent, and
    // joined onto the account's page by pushWhatIsOwed the moment one can be read.
    if (!this.cache.hasRead(day)) {
      this.cache.hold({ day, body: draft.body, mood: draft.mood, energy: draft.energy, source: 'typed' });
      const landed = this.cache.flush();
      this.settle(landed ? 'device' : 'unsaved');
      if (this.signedIn) this.scheduleRetry();
      return;
    }

    const page = {
      day, body: draft.body, mood: draft.mood, energy: draft.energy, source: 'typed', stamp: this.mint(),
    };
    this.cache.store(page, { needsPush: true, read: true });
    const landed = this.cache.flush();
    try {
      const winner = normalizePage(await this.api.putPage(day, wireOf(page)));
      this.cache.markPushed(day, winner);
      this.cache.flush();
      this.adoptFields(page, winner);
      this.settle('saved');
    } catch {
      // A write that did not land is not a lost write — it is on the device, marked owed, and the
      // retry carries it. Unless the device refused the bytes too, in which case nothing is holding
      // these words and the note must not pretend otherwise.
      this.settle(landed ? 'offline' : 'unsaved');
      this.scheduleRetry();
    }
  }

  adoptFields(sent, winner) {
    this.draft = {
      body: this.draft.body === sent.body ? winner.body : this.draft.body,
      mood: this.draft.mood === sent.mood ? winner.mood : this.draft.mood,
      energy: this.draft.energy === sent.energy ? winner.energy : this.draft.energy,
    };
    this.emit();
  }

  // One write, one beat. The tick is what the marker's note watches, so two saves that land in the
  // same state still read as two saves rather than as one that never faded.
  settle(state) {
    this.saveState = state;
    this.saveTick += 1;
    this.emit();
  }

  // What is owed after a failure is sometimes a WRITE and sometimes a READ — a day held unread owes
  // a read before it can owe anything else — so the retry is the whole sync, never just the put.
  scheduleRetry() {
    this.clearTimer(this.retryTimer);
    if (this.disposed) { this.retryTimer = null; return; }
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.saveTimer) return undefined;
      return this.sync();
    }, RETRY_DELAY);
  }

  // The days that were written, oldest first, with the unwritten ones between them drawn as gaps —
  // the canvas is a calendar with holes in it, not a list. Today is never here: it is the draft.
  drawFromCache() {
    const written = this.cache.pages().filter((page) => page.day < this.today && isWritten(page));
    const earliest = written.length ? written[0].day : null;
    this.history = earliest
      ? span(earliest, daysBefore(this.today, 1)).map((date) => {
        const page = this.cache.page(date);
        if (!page || !isWritten(page)) return { date, body: '', mood: null, energy: null, written: false };
        return { date, body: page.body, mood: page.mood, energy: page.energy, written: true };
      })
      : [];
    const mine = this.cache.page(this.today);
    if (mine && !this.touched) this.draft = { body: mine.body, mood: mine.mood, energy: mine.energy };
    this.emit();
  }

  // Flush a queued draft on the way out so nothing typed is lost when the canvas leaves.
  dispose() {
    this.disposed = true;
    this.clearTimer(this.saveTimer);
    this.clearTimer(this.retryTimer);
    this.saveTimer = null;
    this.retryTimer = null;
    if (this.savePending) this.persist();
  }
}
