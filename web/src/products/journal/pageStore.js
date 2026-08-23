// The canvas's data: device-first writes, window reads and the sync walk, for one account at a time.

import { journalApi } from './journalApi.js';
import {
  PageCache, anonymousDrafts, dropAnonymousScope, dropUnclaimedPages, isWritten, normalizePage,
  unclaimedPages, winnerOf,
} from './pageCache.js';
import { localDay, daysBefore, mintStamp } from './hlc.js';

export const WINDOW_DAYS = 60;
export const SAVE_DEBOUNCE = 800;
export const RETRY_DELAY = 4000;

// Floor for the unbounded reach-back read: the earliest date the server's date column parses.
export const BEGINNING = '0001-01-01';

function daysBetween(from, to) {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// The inclusive run of local days [from, to], oldest first.
export function span(from, to) {
  const out = [];
  for (let k = daysBetween(from, to); k >= 0; k--) out.push(daysBefore(to, k));
  return out;
}

// Account prose first, this device's words after, one blank line between; neither side is destroyed.
export function joinBodies(account, here) {
  if (!account.trim()) return here;
  if (!here.trim()) return account;
  if (here.includes(account.trim())) return here;
  return `${account.replace(/\s+$/, '')}\n\n${here.replace(/^\s+/, '')}`;
}

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
    openCache = (account) => new PageCache(account),
    api = journalApi,
    mint = mintStamp,
    today = localDay(),
    // Wrapped, not bare: setTimeout invoked on anything but `window` throws "Illegal invocation".
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
    this.draft = { body: '', mood: null, energy: null };
    this.readState = 'loading';                            // 'loading' | 'ready' | 'device' | 'failed'
    this.reach = 'more';                                   // 'more' | 'loading' | 'end' | 'failed'
    this.saveState = 'idle';                               // 'idle' | 'saved' | 'device' | 'offline' | 'unsaved'
    this.saveTick = 0;                                     // bumps per write, so two saves in one state read as two
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

  // `account` is a user id or null.
  async connect(account = null) {
    // StrictMode re-mounts the canvas on the same instance, so a disposed store revives.
    this.disposed = false;
    const signedIn = Boolean(account);
    if ((account ?? null) !== this.scope) this.openScope(account ?? null);
    this.signedIn = signedIn;
    this.drawFromCache();
    if (!signedIn) {
      this.readState = 'device';
      if (this.cache.owed().length) this.saveState = 'device';
      this.emit();
      return;
    }
    if (this.readState === 'device') this.readState = 'loading';
    this.emit();
    await this.sync();
  }

  // Clears the departing account from memory; its pages stay on disk under its own key.
  openScope(account) {
    // The last beat of typing stays owed on the device under the scope it was typed in, never sent.
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

  // Claims what was written signed out: held unstamped, so the owed walk reads the account's page first.
  claimAnonymousDrafts() {
    const drafts = anonymousDrafts(this.cache.storage);
    if (!drafts.length) return;
    // Only once the account's scope has taken the bytes.
    if (this.takeIntoScope(drafts)) dropAnonymousScope(this.cache.storage);
  }

  // Taken in held: no stamp, so the owed walk must read the account's page before it can send them.
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

  // Product side of the shell's forgetDevice: falls back to the anonymous scope.
  forget() {
    this.openScope(null);
    this.signedIn = false;
    this.readState = 'device';
    this.drawFromCache();
  }

  // Owed writes go up before the window read: a day settled as read is written over.
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

  // Whether the store is still open for the account a walk started under; the scope can change across
  // any await.
  holds(scope) {
    return !this.disposed && this.scope === scope;
  }

  // Everything owed, oldest first; stops at the first failure so a backlog replays in order. A permanent
  // refusal is stepped over, or it stands at the head of the queue forever.
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
    if (refused) this.settle('refused');
    return true;
  }

  // A day this device never read: fetch the account's page first, then join; that read earns the stamp.
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
        // Minted only with the account's page for this day in hand.
        stamp: this.mint(),
      },
    };
  }

  // Adopt the account's fields only where the writer has not moved them; a moved body is joined, not raced.
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

  // Midnight: settle the draft under the old day first, then move the calendar. Idempotent — the clock
  // re-asks on every wake and focus.
  rollOver(day) {
    if (!day || day === this.today) return;
    const settling = this.savePending ? this.persist() : null;
    this.clearTimer(this.saveTimer);
    this.saveTimer = null;

    this.today = day;
    this.draft = { body: '', mood: null, energy: null };
    this.touched = false;
    this.drawFromCache();
    return Promise.resolve(settling).then(() => this.sync());
  }

  async loadWindow() {
    const scope = this.scope;
    const from = daysBefore(this.today, WINDOW_DAYS);
    let pages;
    try {
      pages = await this.api.range(from, this.today);
    } catch {
      // A failed read is not an empty account: leave the window unread so nothing writes over it.
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
    // An empty window leaves nothing to press "further back" from, so settle the reach here.
    if (pages.length === 0) await this.reachToBeginning(daysBefore(from, 1));
  }

  // One window deeper per press; an empty window reaches to the beginning in the same press.
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

  // Everything older than `to`, with no floor under it; asked only after a window came back empty.
  async reachToBeginning(to) {
    const scope = this.scope;
    let pages;
    try {
      pages = await this.api.range(BEGINNING, to);
    } catch {
      // A failed read is not the beginning: absorb nothing, leave the walk open.
      this.reach = 'failed';
      this.emit();
      return;
    }
    // Absorb from the oldest page, never from the floor: year one would mark ~700k days as read.
    if (!this.holds(scope)) return;
    if (pages.length > 0) {
      this.absorb(pages.reduce((oldest, page) => (page.day < oldest ? page.day : oldest), to), to, pages);
    }
    this.reach = 'end';
    this.drawFromCache();
  }

  // Reach past the window so an older hit can be flown to; never decides readState, a failure is a no-op.
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

  // Days the account did not name are marked read too: it holds nothing there.
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

  // A scale writes immediately. `null` is the explicit clear the numeral sends; 0 is a real value.
  set(field, value) {
    this.touched = true;
    this.savePending = true;
    this.draft = { ...this.draft, [field]: value };
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
      // Midnight can move the calendar under a reply in flight; never adopt yesterday's page into tonight's.
      if (day === this.today) this.adoptFields(page, winner);
      this.settle('saved');
    } catch (failure) {
      // Owed on the device and carried by the retry — unless the device refused the bytes too, or the
      // server refused them permanently.
      if (landed && isPermanentRefusal(failure)) {
        this.settle('refused');
        return;
      }
      this.settle(landed ? 'offline' : 'unsaved');
      this.scheduleRetry();
    }
  }

  // A stamp claims to have written last (the backend resolves two writers on the greater stamp), so it is
  // minted only for a day this device has read. An unread day is held instead: unstamped, unsent, joined
  // onto the account's page by pushWhatIsOwed. `page: null` means nothing here may be sent.
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

  settle(state) {
    this.saveState = state;
    this.saveTick += 1;
    this.emit();
  }

  // The retry is the whole sync, never just the put: a failure can owe a read too.
  scheduleRetry() {
    this.clearTimer(this.retryTimer);
    if (this.disposed) { this.retryTimer = null; return; }
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.saveTimer) return undefined;
      return this.sync();
    }, RETRY_DELAY);
  }

  // Written days only, oldest first; today is never here — it is the draft.
  drawFromCache() {
    this.history = this.cache.pages()
      .filter((page) => page.day < this.today && isWritten(page))
      .map((page) => ({ date: page.day, body: page.body, mood: page.mood, energy: page.energy }));
    const mine = this.cache.page(this.today);
    if (mine && !this.touched) this.draft = { body: mine.body, mood: mine.mood, energy: mine.energy };
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.clearTimer(this.saveTimer);
    this.clearTimer(this.retryTimer);
    this.saveTimer = null;
    this.retryTimer = null;
    if (this.savePending) this.persist();
  }
}

// Every store a mounted canvas is holding.
const openStores = new Set();

export function holdStore(store) {
  openStores.add(store);
  return () => openStores.delete(store);
}

export function forgetOpenStores() {
  for (const store of openStores) store.forget();
}

// Quarantined pages taken into an account's scope as held drafts. Answers how many were taken; a device
// that refused the write answers 0 and leaves them in quarantine.
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

// The account's pages joined with this device's. `source` is 'account' | 'device' | 'failed', so a caller
// can tell a corpus that could not be read from an empty journal.
export async function corpus({
  api = journalApi,
  account = null,
  cache = new PageCache(account),
  signedIn = Boolean(account),
} = {}) {
  if (!signedIn) return { pages: joinCorpus([], cache), source: 'device' };
  try {
    return { pages: joinCorpus(await api.allPages(), cache), source: 'account' };
  } catch {
    return { pages: joinCorpus([], cache), source: 'failed' };
  }
}

// One list ordered by day, last-writer-wins by stamp — except an owed page, which carries no stamp and
// wins outright. Blank days are dropped.
export function joinCorpus(account, cache) {
  const byDay = new Map(account.map((page) => [page.day, normalizePage(page)]));
  for (const page of cache.pages()) byDay.set(page.day, winnerOf(page, byDay.get(page.day) ?? null));
  for (const entry of cache.owed()) byDay.set(entry.page.day, entry.page);
  return [...byDay.values()].filter(isWritten).sort((a, b) => (a.day < b.day ? -1 : 1));
}
