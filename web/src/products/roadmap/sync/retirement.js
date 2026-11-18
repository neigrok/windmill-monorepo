// What the server tells a retired build, and what the build does: it stops sending, keeps everything in the store the next
// build carries over, and reloads for that build at the first moment it loses nothing a person holds.

import * as beacon from '../../../telemetry/beacon.js';
import { sessionStorageOrNothing } from '../persistence/browserStorage.js';
import { stepDraftSession } from '../step/StepDraftSession.js';

// The one answer that retires a build, from a roadmap write route or from the socket's path. No other answer does.
const RETIRED = Object.freeze({ status: 410, code: 'client-update-required' });

// After a socket that never opened, its path is read once, plainly, never while offline, at most once a minute, for ten
// seconds at most: a browser cannot read why an upgrade failed, and a reconnect loop must not become a probe storm.
export const PROBE_SPACING_MS = 60_000;
const PROBE_LIMIT_MS = 10_000;
// A tab reloads for a retired build at most once in this window, so a page served stale stays offline instead of looping.
export const RELOAD_WINDOW_MS = 10 * 60_000;
// The person is between gestures once no pointer is pressed and no input has come for this long.
export const IDLE_MS = 3000;
const RECHECK_MS = 1000;
const RELOAD_MARK = 'windmill:roadmap:retired-reload';
const LOST_CONNECTIONS = new Set(['TypeError', 'AbortError', 'TimeoutError']);
const TEXT_FIELDS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

// Whether an answer is exactly the retired one; any other answer, a 410 with another body among them, is not.
export async function saysRetired(response) {
  if (response.status !== RETIRED.status) return false;
  const body = await response.clone().json().catch(() => null);
  return body?.code === RETIRED.code;
}

// The page a retired build reloads: what a person holds open in it, whether they are between gestures, and the mark that
// keeps the tab from reloading for a retired build twice in one window.
export class RetiredPage {
  constructor({ document = globalThis.document, window = globalThis.window, storage = sessionStorageOrNothing(), now = Date.now } = {}) {
    this.document = document;
    this.window = window;
    this.storage = storage;
    this.now = now;
    this.pressed = new Set();
    this.lastInputAt = 0;
  }

  // What a reload would lose: a step draft the shared-field guard holds, active or retained, a text field in focus, or an
  // open dialog.
  holdsWork() {
    if (stepDraftSession(this.document, { create: false })?.getSnapshot()) return true;
    const focused = this.document.activeElement;
    if (focused?.isContentEditable || focused?.tagName === 'TEXTAREA' || (focused?.tagName === 'INPUT' && TEXT_FIELDS.has(focused.type))) return true;
    return this.document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') !== null;
  }

  // Between gestures: the page is hidden, or no pointer is pressed and no input has come for IDLE_MS.
  resting() {
    if (this.document.visibilityState === 'hidden') return true;
    return this.pressed.size === 0 && this.now() - this.lastInputAt >= IDLE_MS;
  }

  // Follows the person's input from now on, and calls `onChange` when the page is hidden or shown. Answers the stop.
  watch(onChange) {
    this.lastInputAt = this.now();
    const input = (event) => {
      this.lastInputAt = this.now();
      if (event.type === 'pointerdown') this.pressed.add(event.pointerId);
      if (event.type === 'pointerup' || event.type === 'pointercancel') this.pressed.delete(event.pointerId);
    };
    const inputs = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'wheel'];
    for (const type of inputs) this.window.addEventListener(type, input, { capture: true, passive: true });
    this.document.addEventListener('visibilitychange', onChange);
    return () => {
      for (const type of inputs) this.window.removeEventListener(type, input, { capture: true });
      this.document.removeEventListener('visibilitychange', onChange);
    };
  }

  // When this tab last reloaded for a retired build, or null.
  reloadMark() {
    try {
      const at = Number(this.storage.getItem(RELOAD_MARK));
      return at > 0 ? at : null;
    } catch {
      return null;
    }
  }

  // Whether the mark was kept: a page that cannot keep it cannot be kept from reloading again, so it must not reload.
  markReload() {
    try {
      const at = String(this.now());
      this.storage.setItem(RELOAD_MARK, at);
      return this.storage.getItem(RELOAD_MARK) === at;
    } catch {
      return false;
    }
  }

  reload() {
    this.window.location.reload();
  }
}

// Whether the server has retired this build, one fact for the whole page. `retired` is the door that said so first,
// `socket` or `write`, or null. A session enlists while it runs: it is retired with the build, and the reload waits for
// the act it holds and for its saves to reach the device. The page reloads only while a session is enlisted.
export class BuildRetirement {
  constructor({ page = null, fetch = (...args) => globalThis.fetch(...args), events = beacon, timers = globalThis, now = Date.now,
    online = () => globalThis.navigator?.onLine !== false } = {}) {
    this.page = page;
    this.fetch = fetch;
    this.events = events;
    this.timers = timers;
    this.now = now;
    this.online = online;
    this.retired = null;
    this.sessions = new Set();
    this.holds = new Set();
    this.probing = false;
    this.probedAt = -Infinity;
    this.wanted = false;
    this.reloading = false;
    this.watching = null;
  }

  enlist(session) {
    this.sessions.add(session);
    if (this.retired) session.retire();
    this.watch();
    return () => {
      this.sessions.delete(session);
      if (this.sessions.size === 0) this.unwatch();
    };
  }

  // A surface that keeps what a person typed in its own state alone holds the reload off while it does. Answers the release.
  hold() {
    const held = {};
    this.holds.add(held);
    return () => this.holds.delete(held);
  }

  // `report` is the reporter of the door that said so, for a session that throws as it is retired.
  declare(door, report) {
    if (this.retired) return;
    this.retired = door;
    this.page ??= new RetiredPage();
    this.events.track('roadmap_sync_retired', { step: 'detected', door });
    for (const session of this.sessions) {
      try {
        session.retire();
      } catch (error) {
        report('roadmap-sync-retire', error);
      }
    }
    this.reloadWhenSafe();
  }

  // A plain read of the socket's path after a socket that never opened: only the exact retired answer retires the build.
  // A lost connection says nothing; anything else that stops the read is the caller's to `report`.
  async probeSocket(socketUrl, report) {
    if (this.retired || this.probing || !this.online() || this.now() - this.probedAt < PROBE_SPACING_MS) return;
    this.probing = true;
    this.probedAt = this.now();
    let retired = false;
    try {
      const response = await this.fetch(socketUrl.replace(/^ws/, 'http'), {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(PROBE_LIMIT_MS),
      });
      retired = await saysRetired(response);
    } catch (error) {
      if (!LOST_CONNECTIONS.has(error?.name)) report('roadmap-sync-probe', error);
    } finally {
      this.probing = false;
    }
    if (retired) this.declare('socket', report);
  }

  // Once a window at most. Inside one the reload is suppressed and tried again as the window ends, so a page served the
  // same build stays offline only until then; a page that cannot keep the mark stays offline.
  reloadWhenSafe() {
    const since = this.now() - (this.page.reloadMark() ?? -Infinity);
    if (since < RELOAD_WINDOW_MS) {
      this.suppress();
      this.timers.setTimeout(() => this.reloadWhenSafe(), RELOAD_WINDOW_MS - since);
      return;
    }
    if (!this.page.markReload()) return this.suppress();
    this.wanted = true;
    this.watch();
    if (!this.safe()) this.events.track('roadmap_sync_retired', { step: 'reload', door: this.retired, outcome: 'deferred' });
    this.reloadIfSafe();
  }

  watch() {
    if (!this.wanted || this.watching || this.sessions.size === 0) return;
    const attempt = () => { this.reloadIfSafe(); };
    this.watching = { stop: this.page.watch(attempt), recheck: this.timers.setInterval(attempt, RECHECK_MS) };
  }

  unwatch() {
    if (!this.watching) return;
    this.watching.stop();
    this.timers.clearInterval(this.watching.recheck);
    this.watching = null;
  }

  suppress() {
    this.events.track('roadmap_sync_retired', { step: 'reload', door: this.retired, outcome: 'suppressed' });
  }

  // A roadmap session is enlisted and nothing a person holds is open — no hold, no held act, no draft, no text field in
  // focus, no dialog — and they are between gestures, or the page is hidden.
  safe() {
    const sessions = [...this.sessions];
    return sessions.length > 0 && this.holds.size === 0 && !sessions.some((session) => session.holdsAct())
      && !this.page.holdsWork() && this.page.resting();
  }

  // Every session's save must succeed in a store that keeps it on the device, or the page stays offline with what it holds.
  async reloadIfSafe() {
    if (this.reloading || !this.wanted || !this.safe()) return;
    this.reloading = true;
    const saved = await Promise.allSettled([...this.sessions].map(async (session) => session.savedOnDevice()));
    this.reloading = false;
    if (saved.some((result) => result.value !== true)) {
      this.wanted = false;
      this.unwatch();
      return this.suppress();
    }
    if (!this.safe()) return;
    this.wanted = false;
    this.unwatch();
    if (!this.page.markReload()) return this.suppress();
    this.events.track('roadmap_sync_retired', { step: 'reload', door: this.retired, outcome: 'ran' });
    this.page.reload();
  }
}

export const buildRetirement = new BuildRetirement();
