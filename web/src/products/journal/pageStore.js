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
// AND AN EMPTY SIXTY-DAY WINDOW IS NOT AN EMPTY JOURNAL — the same rule one step further out.
// `reach` is the walk back past the window: one window deeper per press, and the beginning of the
// journal said out loud once a read has actually reached it. A read that FAILED while reaching back
// is 'failed' and never 'end', because telling a writer with two years of pages that their journal
// starts in June is the same lie, told about the other edge.
//
// A STAMP IS ONLY EVER MINTED AGAINST A PAGE THIS DEVICE HAS READ. See persist() and
// joinOntoAccount() below; that rule is what makes the two above matter.
//
// A REPLY IS A RECEIPT FOR ONE WRITE, NEVER FOR EVERY WRITE — the cache's markPushed keeps a newer
// unsent draft owed, so a slow reply cannot swallow the last thing someone typed.
//
// AND THE STORE IS ALWAYS OPEN FOR EXACTLY ONE ACCOUNT. connect() is given a user id (or null for
// signed out), and a change of that id re-opens the device tier under the arriving account's own
// key AND clears what the departing one left in memory — the canvas, today's draft, the pending
// save. Both halves are needed and neither is enough: the key is what protects a browser whose tab
// crashed before anything could be cleared, and the memory reset is what protects the person
// standing in front of a canvas that was already painted.

import { journalApi } from './journalApi.js';
import {
  PageCache, anonymousDrafts, dropAnonymousScope, dropUnclaimedPages, isWritten, normalizePage,
  unclaimedPages, winnerOf,
} from './pageCache.js';
import { localDay, daysBefore, mintStamp } from './hlc.js';

export const WINDOW_DAYS = 60;
export const SAVE_DEBOUNCE = 800;
export const RETRY_DELAY = 4000;

// A day before any journal. The window read walks back a window at a time, but "is there anything
// older at all" has to be asked with no floor under it, and the wire only takes a date — so this
// is the floor, and it is the earliest one the server's date column will parse.
export const BEGINNING = '0001-01-01';

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

// A refusal the server will give again for the same bytes, however long we wait. 4xx says the
// request was wrong, not that the network was — with the three exceptions that really do come good
// on their own: an expired session (the seat resolves and the write is re-owed), a request timeout,
// and a rate limit. Everything else, 413 included, is answered by changing the page, not by retrying.
function isPermanentRefusal(failure) {
  const status = failure?.status;
  if (typeof status !== 'number') return false;
  if (status === 401 || status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function wireOf(page) {
  return { body: page.body, mood: page.mood, energy: page.energy, source: page.source, stamp: page.stamp };
}

export class PageStore {
  constructor({
    // The device tier is opened per account rather than handed in, because who is signed in changes
    // under a mounted canvas and the store is what has to follow that change. A fresh store belongs
    // to nobody yet, which is the anonymous scope — connect() re-opens it the moment auth settles.
    openCache = (account) => new PageCache(account),
    api = journalApi,
    mint = mintStamp,
    today = localDay(),
    // WRAPPED, NEVER HANDED OVER BARE. `this.setTimer(…)` calls whatever is here as a method of the
    // store, and a browser's timer functions check their receiver: `window.setTimeout` invoked on
    // anything but `window` throws "Illegal invocation", which took the canvas down at mount — the
    // dispose() in React's StrictMode double-invoke was the first call to reach one. Node's timers
    // do not check, so the whole suite passed over a room nobody could open.
    setTimer = (run, delay) => setTimeout(run, delay),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.openCache = openCache;
    this.scope = null;
    this.cache = openCache(null);
    this.api = api;
    this.mint = mint;
    this.today = today;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.history = [];                                    // [{date, body, mood, energy}], written days oldest→newest
    this.draft = { body: '', mood: null, energy: null };   // today, the live draft
    this.readState = 'loading';                            // 'loading' | 'ready' | 'device' | 'failed'
    this.reach = 'more';                                   // 'more' | 'loading' | 'end' | 'failed'
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

  // Nothing written, EVER — the first-run surface, and the strongest claim this store makes about
  // an account. Computed rather than stored so no code path can leave it true, and only ever from a
  // read that both landed and reached the beginning:
  //
  //   · a failed read knows nothing about whether this account is new;
  //   · a window read that came back empty proves sixty quiet days and nothing more — a writer who
  //     has been away longer than that would otherwise be handed a virgin canvas and told to start
  //     anywhere, with two years of their own pages one read away.
  //
  // Signed out is the one case that needs no read at all: nobody is signed in, so this device IS
  // the whole record, and an empty device is genuinely a first run.
  isFirstRun() {
    const empty = this.history.length === 0
      && this.draft.body.trim() === '' && this.draft.mood == null && this.draft.energy == null;
    if (!empty) return false;
    if (this.readState === 'device') return true;
    return this.readState === 'ready' && this.reach === 'end';
  }

  buildSnapshot() {
    return {
      today: this.today,
      history: this.history,
      loading: this.readState === 'loading',
      readState: this.readState,
      reach: this.reach,
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

  // Called on mount and on every change of WHO is signed in — `account` is a user id, or null for
  // signed out. Draws from the device first and always — a canvas that waited for a network round
  // trip would be a cursor that waits.
  async connect(account = null) {
    // Connecting is what puts the store back in service, so dispose() is a pause rather than a
    // death: React StrictMode mounts, tears down and re-mounts the canvas on the SAME store, and a
    // one-way flag would leave the second life unable to read anything, in dev only.
    this.disposed = false;
    const signedIn = Boolean(account);
    if ((account ?? null) !== this.scope) this.openScope(account ?? null);
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

  // The account arriving at this canvas — the load-bearing half of the fix for JOURNAL-1. The
  // device tier is re-opened under the arriving account's own key (pageCache.js), so the previous
  // account's pages are not filtered out here, they are never read; and everything the previous
  // account left in MEMORY goes with them, because the canvas, the draft and the queued save were
  // painted for somebody who is no longer here.
  //
  // The departing account's pages STAY ON DISK under its own key. That is deliberate: they are its
  // own unsent work and its own cache, they are unreachable from any other scope, and wiping them
  // would mean a person who signs out and back in on their own laptop loses the page they wrote on
  // a plane. Sign-out ends the session, not the writing.
  openScope(account) {
    // The last beat of typing before the account changed is put on the DEVICE — into the scope it
    // was typed under, where it stays owed until that person signs back in — and is never sent:
    // the only session this browser has left belongs to somebody else, and a PUT now would be
    // JOURNAL-1 with the arriving account's cookie on it. Skipping this altogether is what the
    // first cut did, and it ate up to SAVE_DEBOUNCE of somebody's writing on every sign-out.
    if (this.savePending) this.keepDraftOnDevice();
    this.clearTimer(this.saveTimer);
    this.clearTimer(this.retryTimer);
    this.saveTimer = null;
    this.retryTimer = null;
    this.savePending = false;
    this.syncing = false;

    const leavingAnon = this.scope === null;
    this.scope = account;
    this.cache = this.openCache(account);
    this.history = [];
    this.draft = { body: '', mood: null, energy: null };
    this.touched = false;
    this.readState = 'loading';
    this.reach = 'more';
    this.saveState = 'idle';
    if (account && leavingAnon) this.claimAnonymousDrafts();
  }

  // Signing in claims what was written here while nobody was — additive, always: each anonymous
  // draft is JOINED onto whatever this account's scope already holds for that day and held
  // unstamped, so pushWhatIsOwed reads the account's real page and joins onto that too. Nothing an
  // account wrote can be raced or replaced by a draft that never read it.
  claimAnonymousDrafts() {
    const drafts = anonymousDrafts(this.cache.storage);
    if (!drafts.length) return;
    // Only once the account's scope has taken the bytes: a device that refused the write is still
    // holding these words in the anonymous scope, and the next sign-in gets to claim them again.
    if (this.takeIntoScope(drafts)) dropAnonymousScope(this.cache.storage);
  }

  // Pages from outside this scope, taken into it — the anonymous claim, and the restore of pages
  // quarantined from before scoping existed. They arrive HELD: joined onto whatever this account
  // already holds for the day and carrying no stamp, so pushWhatIsOwed has to read the account's
  // real page and join onto that too. That is what makes taking them additive rather than a race —
  // nothing an account wrote can be replaced by prose that never read it.
  takeIntoScope(pages) {
    for (const page of pages) {
      const mine = this.cache.page(page.day);
      this.cache.hold({
        day: page.day,
        body: joinBodies(mine?.body ?? '', page.body),
        mood: page.mood ?? mine?.mood ?? null,
        energy: page.energy ?? mine?.energy ?? null,
        source: page.source,
      });
    }
    return this.cache.flush();
  }

  // The shell's forgetDevice, product side: the account that was here is gone, so nothing of theirs
  // may remain on screen or in this store. The store falls back to the anonymous scope — the same
  // place a signed-out writer's words live — and the arriving account (if there is one) opens its
  // own scope on the connect that follows.
  forget() {
    this.openScope(null);
    this.signedIn = false;
    this.readState = 'device';
    this.drawFromCache();
  }

  // Everything the account and this device owe each other, in the one order that is safe: what is
  // owed goes UP first, because the window read is what settles a day as read — and a day settled
  // before its held words were joined onto it would look like an ordinary page to write over.
  async sync() {
    if (!this.signedIn || this.disposed || this.syncing) return;
    const scope = this.scope;
    this.syncing = true;
    try {
      if (!(await this.pushWhatIsOwed())) return;
      if (!this.holds(scope)) return;
      await this.loadWindow();
    } finally {
      this.syncing = false;
    }
  }

  // Whether the store is still open for the account this walk started under. Every network step
  // here is an await, and who is signed in can change across one — a sign-out, or another tab
  // signing in as somebody else. An answer that belongs to the departed account must not be written
  // into the arriving one's cache or drawn on its canvas; that is the same leak as JOURNAL-1,
  // arriving a second late.
  holds(scope) {
    return !this.disposed && this.scope === scope;
  }

  // The claim (auth canon: adoption is additive) and the reconnect drain are one walk — everything
  // this device owes, oldest first, so a backlog replays in the order it was lived. It stops at the
  // first failure: order is the point, and a retry is already scheduled.
  //
  // A REFUSAL IS NOT A FAILURE TO STOP AT. A page the server will never accept — too long, or a day
  // whose stamp this device garbled — would otherwise stand at the head of the queue forever: every
  // later day unsent, the account's own window never read, the canvas never finished opening, and no
  // retry scheduled to break out of it. So a refusal is stepped over rather than stopped at. The
  // day keeps its words and stays owed, the walk finishes, and the read that follows still happens.
  async pushWhatIsOwed() {
    const scope = this.scope;
    let refused = false;
    for (const entry of this.cache.owed()) {
      const resolved = entry.read
        ? { sent: entry.page, recovered: null }
        : await this.joinOntoAccount(entry);
      if (!this.holds(scope)) return false;
      if (!resolved) { this.cache.flush(); this.settle('offline'); this.scheduleRetry(); return false; }

      let winner;
      try {
        winner = normalizePage(await this.api.putPage(resolved.sent.day, wireOf(resolved.sent)));
      } catch (failure) {
        this.cache.flush();
        // A refusal is not an outage, and waiting is not the remedy for it — but it is also not a
        // reason to abandon the days behind it. Step over it, remember that it happened, and let
        // the walk (and the window read after it) finish.
        if (isPermanentRefusal(failure)) {
          refused = true;
          continue;
        }
        this.settle('offline');
        this.scheduleRetry();
        return false;
      }
      if (!this.holds(scope)) return false;
      this.cache.markPushed(resolved.sent.day, winner);
      this.settleDraft(entry, resolved, winner);
    }
    this.cache.flush();
    // Said after the walk rather than during it, so the last word is about the whole backlog and
    // not about whichever day happened to be refused in the middle of it.
    if (refused) this.settle('refused');
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
    const scope = this.scope;
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
    if (!this.holds(scope)) return;
    this.absorb(from, this.today, pages);
    this.readState = 'ready';
    this.drawFromCache();
    // Sixty quiet days is not an empty journal, and this is the one place that difference is
    // invisible: with nothing in the window there is no canvas to press "read further back" from,
    // so the walk would have no foot to stand on and `firstRun` would be claimed on the window's
    // word alone. Settle it here instead — for a genuinely new account the answer costs one empty
    // read, and for a writer who has been away three months it is their journal.
    if (pages.length === 0) await this.reachToBeginning(daysBefore(from, 1));
  }

  // ONE WINDOW DEEPER PER PRESS — the foot of gym's log, stood on its head, because the top of a
  // canvas asks the same question the bottom of a list does: is this everything? A window that
  // comes back with pages leaves the walk open; there may always be more.
  //
  // A window that comes back EMPTY is settled in the same press rather than left for the writer to
  // press through years of silence: nothing here says "start of your journal" until a read has
  // actually reached one.
  async reachBack() {
    if (this.readState !== 'ready' || this.reach === 'loading' || this.reach === 'end') return;
    const scope = this.scope;
    this.reach = 'loading';
    this.emit();

    const to = this.history.length
      ? daysBefore(this.history[0].date, 1)
      : daysBefore(this.today, WINDOW_DAYS + 1);
    const from = daysBefore(to, WINDOW_DAYS);
    let pages;
    try {
      pages = await this.api.range(from, to);
    } catch {
      this.reach = 'failed';
      this.emit();
      return;
    }
    if (!this.holds(scope)) return;
    this.absorb(from, to, pages);
    if (pages.length === 0) {
      await this.reachToBeginning(daysBefore(from, 1));
      return;
    }
    this.reach = 'more';
    this.drawFromCache();
  }

  // The one read that can settle where a journal starts: everything older than a day, with no floor
  // under it. Asked only after a window has already come back empty, so for most writers it answers
  // nothing at all — and when it does answer, what comes back IS the rest of the journal, which
  // leaves the canvas standing at its true beginning either way.
  async reachToBeginning(to) {
    const scope = this.scope;
    let pages;
    try {
      pages = await this.api.range(BEGINNING, to);
    } catch {
      // A READ THAT FAILED IS NOT THE BEGINNING OF A JOURNAL. Nothing absorbed, nothing settled,
      // and the walk stays open so the same step can be offered again.
      this.reach = 'failed';
      this.emit();
      return;
    }
    // Absorbed from the oldest page BACK, never from the floor: marking every day since year one as
    // read would be seven hundred thousand entries, and the days below the first page are days
    // nobody wrote rather than days the canvas draws.
    if (!this.holds(scope)) return;
    if (pages.length > 0) {
      this.absorb(pages.reduce((oldest, page) => (page.day < oldest ? page.day : oldest), to), to, pages);
    }
    this.reach = 'end';
    this.drawFromCache();
  }

  // Reach further back than the initial window so a search hit or an echo older than the canvas can
  // still be flown to. A secondary read: it never decides readState, and a failure is a no-op.
  async extendTo(date) {
    const scope = this.scope;
    const earliest = this.history.length ? this.history[0].date : daysBefore(this.today, 1);
    if (!date || date >= earliest) return;
    const to = daysBefore(earliest, 1);
    let pages;
    try {
      pages = await this.api.range(date, to);
    } catch {
      return;
    }
    if (!this.holds(scope)) return;
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
    const scope = this.scope;
    const day = this.today;
    const kept = this.keepDraftOnDevice();
    if (!kept.page) {
      this.settle(kept.landed ? 'device' : 'unsaved');
      if (this.signedIn) this.scheduleRetry();
      return;
    }

    const { page, landed } = kept;
    try {
      const winner = normalizePage(await this.api.putPage(day, wireOf(page)));
      if (!this.holds(scope)) return;
      this.cache.markPushed(day, winner);
      this.cache.flush();
      this.adoptFields(page, winner);
      this.settle('saved');
    } catch (failure) {
      // A write that did not land is not a lost write — it is on the device, marked owed, and the
      // retry carries it. Unless the device refused the bytes too, in which case nothing is holding
      // these words and the note must not pretend otherwise.
      //
      // And unless the SERVER refused them, which is a different thing again: the page is too long
      // to store (413) and every retry will be refused for the same reason. Saying "offline" then
      // is a lie repeated on a timer, so the note says what is true — the words are here, they are
      // too long to sync — and the timer stops. A next edit owes the page again, so shortening it
      // is the remedy.
      if (landed && isPermanentRefusal(failure)) {
        this.settle('refused');
        return;
      }
      this.settle(landed ? 'offline' : 'unsaved');
      this.scheduleRetry();
    }
  }

  // THE WORDS LAND ON THE DEVICE FIRST — the whole of a write except the sending, which is why the
  // scope change can borrow it: a person leaving keeps what they typed, in their own scope, owed.
  //
  // THE STAMP RULE lives here, at the one place a write is born. A stamp is a claim to have written
  // LAST — backend/products/journal/domain/Page.h resolves two writers on the greater stamp — and
  // this device may only make that claim about a page it has actually read. A day it has not read
  // (nobody signed in, or the window read failed) is HELD instead: unstamped, unsent, and joined
  // onto the account's page by pushWhatIsOwed the moment one can be read. That is what `page: null`
  // means to the caller — there is nothing here that may be sent.
  keepDraftOnDevice() {
    const day = this.today;
    const draft = this.draft;
    if (!this.cache.hasRead(day)) {
      this.cache.hold({ day, body: draft.body, mood: draft.mood, energy: draft.energy, source: 'typed' });
      return { page: null, landed: this.cache.flush() };
    }
    const page = {
      day, body: draft.body, mood: draft.mood, energy: draft.energy, source: 'typed', stamp: this.mint(),
    };
    this.cache.store(page, { needsPush: true, read: true });
    return { page, landed: this.cache.flush() };
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

  // The days that were WRITTEN, oldest first — and only those. A day nobody wrote is not drawn at
  // all: the canvas is what you wrote, not a calendar with holes in it, and saying nothing about a
  // missed day is the strongest reading of "no scoring" — an unwritten day cannot be counted,
  // coloured or apologised for if it was never put on the page. iOS's PageStore draws it the same
  // way. Today is never here: it is the draft.
  drawFromCache() {
    this.history = this.cache.pages()
      .filter((page) => page.day < this.today && isWritten(page))
      .map((page) => ({ date: page.day, body: page.body, mood: page.mood, energy: page.energy }));
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

// Every store a mounted canvas is holding. The shell tells the journal that the account changed
// (routes.js `forgetDevice`), and the disk half of that is settled by the scope key alone — but the
// canvas on screen was painted from memory by whoever was here a moment ago, and only the store
// that painted it can clear it. usePages registers one store per mount and drops it on unmount, so
// this set is exactly the canvases that exist.
const openStores = new Set();

export function holdStore(store) {
  openStores.add(store);
  return () => openStores.delete(store);
}

export function forgetOpenStores() {
  for (const store of openStores) store.forget();
}

// The restore, and the ONLY way anything quarantined out of the old unscoped store ever reaches an
// account: a signed-in person asked for it by hand (settings/YourJournalSection.jsx). The pages are
// taken into that account's scope as held drafts — joined, unstamped, exactly like the anonymous
// claim — and go up through the ordinary owed walk. An account is required: nobody can be given
// pages nobody could attribute without saying out loud that they are theirs.
//
// Answers how many pages were taken, so the surface can say it plainly. A device that refused the
// write keeps them in quarantine and answers 0 — the offer stands rather than the words vanishing.
export async function restoreUnclaimedPages(account) {
  if (!account) return 0;
  const pages = unclaimedPages();
  if (!pages.length) return 0;
  const canvas = [...openStores].find((store) => store.scope === account);
  const store = canvas ?? new PageStore();
  if (!canvas) await store.connect(account);
  if (!store.takeIntoScope(pages)) return 0;
  dropUnclaimedPages(store.cache.storage);
  store.drawFromCache();
  await store.sync();
  if (!canvas) store.dispose();
  return pages.length;
}

// THE WHOLE JOURNAL, for the two readers that want all of it rather than a window: search's index
// and the year zoom. Both read the account and only the account, which was the whole truth until
// the device tier landed — a signed-out writer's pages are now real pages that live here, and their
// own search must not be blind to them.
//
// `source` is the other half, and it is the canvas's rule said again: a corpus that could not be
// read is not an empty journal, so a caller can say which of these three it is looking at instead
// of drawing a blank year over a failed read.
//
// `account` is the user id whose device scope this corpus is built from — the same scope the canvas
// is open for. Search and the year zoom read the device tier too, so an unscoped read here would
// have put the previous user's pages into the arriving one's ⌘K results and year grid even after
// the canvas itself was clean.
export async function corpus({
  api = journalApi,
  account = null,
  cache = new PageCache(account),
  signedIn = Boolean(account),
} = {}) {
  // Nobody is signed in, so there is no account to read and nothing to be offline from: this device
  // IS the record, exactly as the canvas reads it.
  if (!signedIn) return { pages: joinCorpus([], cache), source: 'device' };
  try {
    return { pages: joinCorpus(await api.allPages(), cache), source: 'account' };
  } catch {
    return { pages: joinCorpus([], cache), source: 'failed' };
  }
}

// The account's pages and this device's, as one list ordered by day. Last-writer-wins by stamp,
// exactly as the cache converges — except for an OWED page, which wins outright: it is words the
// account has not accepted yet, and a HELD one carries no stamp at all by design, so on stamps
// alone it would lose every race it entered and the writer's newest page would be unsearchable.
//
// Blank days are dropped by the canvas's own definition of a written day, so the zoom's grid and
// the canvas agree about which squares are warm.
export function joinCorpus(account, cache) {
  const byDay = new Map(account.map((page) => [page.day, normalizePage(page)]));
  for (const page of cache.pages()) byDay.set(page.day, winnerOf(page, byDay.get(page.day) ?? null));
  for (const entry of cache.owed()) byDay.set(entry.page.day, entry.page);
  return [...byDay.values()].filter(isWritten).sort((a, b) => (a.day < b.day ? -1 : 1));
}
