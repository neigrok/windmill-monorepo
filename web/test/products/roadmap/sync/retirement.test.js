import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BuildRetirement, IDLE_MS, PROBE_SPACING_MS, RELOAD_WINDOW_MS, RetiredPage, saysRetired,
} from '../../../../src/products/roadmap/sync/retirement.js';
import { stepDraftSession } from '../../../../src/products/roadmap/step/StepDraftSession.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
// What production answers a plain GET of /v1/socket today: Drogon's own page for a path no HTTP handler serves.
const TODAYS_SOCKET_GET = '<html>\n<head><title>404 Not Found</title></head>\n<body bgcolor="white" text="black">\n<center><h1>404 Not Found</h1></center>\n<hr><center>drogon/1.9.13</center>\n</body>\n</html>';
const RETIRED_BODY = { error: 'This version of the app can no longer save; update it.', code: 'client-update-required' };

class Clock {
  constructor() {
    this.now = 1_000_000;
    this.timers = new Map();
    this.next = 0;
  }
  setInterval(callback) { this.timers.set(++this.next, { callback, every: true }); return this.next; }
  clearInterval(id) { this.timers.delete(id); }
  setTimeout(callback, delay) { this.timers.set(++this.next, { callback, due: this.now + delay }); return this.next; }
  // Every interval runs once, and every timeout that is due.
  tick() {
    for (const [id, { callback, every, due }] of [...this.timers]) {
      if (!every && due > this.now) continue;
      if (!every) this.timers.delete(id);
      callback();
    }
  }
}

class FakePage {
  constructor(clock, { reloadedAt = null, keepsMarks = true, hidden = false, holdsWork = false, resting = false } = {}) {
    Object.assign(this, { clock, markedAt: reloadedAt, keepsMarks, hidden, held: holdsWork, rest: resting });
    this.reloads = 0;
    this.watching = null;
  }
  holdsWork() { return this.held; }
  resting() { return this.hidden || this.rest; }
  watch(onChange) { this.watching = onChange; return () => { this.watching = null; }; }
  reloadMark() { return this.markedAt; }
  markReload() {
    if (this.keepsMarks) this.markedAt = this.clock.now;
    return this.keepsMarks;
  }
  reload() { this.reloads += 1; }
}

class FakeSession {
  constructor(log = []) {
    this.log = log;
    this.retired = 0;
    this.held = false;
    this.kept = true;
    this.reports = [];
  }
  retire() { this.retired += 1; }
  holdsAct() { return this.held; }
  reportFailure(operation, error) { this.reports.push([operation, error]); }
  async savedOnDevice() {
    this.log.push('saved');
    return this.kept;
  }
}

function retirement({ fetch = async () => html(404, TODAYS_SOCKET_GET), online = () => true, reloadedAgo = null, ...pageOptions } = {}) {
  const clock = new Clock();
  const events = [];
  const shown = new FakePage(clock, { ...pageOptions, reloadedAt: reloadedAgo === null ? null : clock.now - reloadedAgo });
  const subject = new BuildRetirement({
    page: shown, fetch, online, timers: clock, now: () => clock.now,
    events: { track: (name, props) => events.push({ name, props }) },
  });
  return { subject, page: shown, clock, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const outcomes = (events) => events.map(({ props }) => props.outcome ?? props.step);
const nothingToReport = () => assert.fail('nothing to report');

test('only a 410 whose body says client-update-required is the retired answer', async () => {
  const answers = [
    [json(410, RETIRED_BODY), true],
    [json(410, { error: 'gone', code: 'id-retired' }), false],
    [json(410, {}), false],
    [html(410, '<html>Gone</html>'), false],
    [json(426, RETIRED_BODY), false],
    [json(400, RETIRED_BODY), false],
    [json(200, RETIRED_BODY), false],
    [html(404, TODAYS_SOCKET_GET), false],
    [new Response(null, { status: 503 }), false],
  ];
  assert.deepEqual(await Promise.all(answers.map(([response]) => saysRetired(response))), answers.map(([, retired]) => retired));
});

test('reading a 410 for the retired answer leaves its body for the door that asked', async () => {
  const response = json(410, { error: 'gone', code: 'id-retired' });
  assert.equal(await saysRetired(response), false);
  assert.deepEqual(await response.json(), { error: 'gone', code: 'id-retired' });
});

test('a socket probe reads the socket’s path plainly over HTTP and retires the build on the exact answer alone', async () => {
  const calls = [];
  const { subject, events } = retirement({ fetch: async (url, init) => { calls.push({ url, init }); return json(410, RETIRED_BODY); } });
  const sessions = [new FakeSession(), new FakeSession()];
  for (const session of sessions) subject.enlist(session);
  const reports = [];
  await subject.probeSocket('wss://windmill.works/v1/socket', (...report) => reports.push(report));
  assert.deepEqual(calls.map(({ url, init }) => ({ url, credentials: init.credentials, cache: init.cache, method: init.method, headers: init.headers })),
    [{ url: 'https://windmill.works/v1/socket', credentials: 'include', cache: 'no-store', method: undefined, headers: undefined }]);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(subject.retired, 'socket');
  assert.deepEqual(sessions.map((session) => session.retired), [1, 1]);
  assert.deepEqual(events[0], { name: 'roadmap_sync_retired', props: { step: 'detected', door: 'socket' } });
  assert.deepEqual(reports, []);
});

test('today’s answer, another 410, a 426, a lost connection and a timeout never retire the build or report', async () => {
  const answers = [
    async () => html(404, TODAYS_SOCKET_GET),
    async () => json(410, { code: 'gone' }),
    async () => json(426, RETIRED_BODY),
    async () => { throw new TypeError('Failed to fetch'); },
    async () => { throw new DOMException('The operation was aborted.', 'AbortError'); },
    async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
  ];
  for (const fetch of answers) {
    const { subject, events } = retirement({ fetch });
    const reports = [];
    await subject.probeSocket('ws://localhost:8088/v1/socket', (...report) => reports.push(report));
    assert.deepEqual({ retired: subject.retired, events, reports }, { retired: null, events: [], reports: [] });
  }
});

test('a probe that fails for any reason but a lost connection reports under its static operation', async () => {
  const failure = new RangeError('private detail');
  const { subject } = retirement({ fetch: async () => { throw failure; } });
  const reports = [];
  await subject.probeSocket('ws://localhost:8088/v1/socket', (...report) => reports.push(report));
  assert.deepEqual(reports, [['roadmap-sync-probe', failure]]);
  assert.equal(subject.retired, null);
});

test('probes are bounded: one at a time, one a minute, none offline and none once retired', async () => {
  let online = true;
  let answer = () => html(404, TODAYS_SOCKET_GET);
  let release;
  const calls = [];
  const { subject, clock } = retirement({
    online: () => online,
    fetch: async (url) => { calls.push(url); await new Promise((resolve) => { release = resolve; }); return answer(); },
  });
  const first = subject.probeSocket('ws://host/v1/socket', nothingToReport);
  await subject.probeSocket('ws://host/v1/socket', nothingToReport);
  release();
  await first;
  clock.now += PROBE_SPACING_MS - 1;
  await subject.probeSocket('ws://host/v1/socket', nothingToReport);
  assert.equal(calls.length, 1, 'a reconnect loop inside the spacing makes no probe');
  online = false;
  clock.now += 1;
  await subject.probeSocket('ws://host/v1/socket', nothingToReport);
  assert.equal(calls.length, 1, 'an offline browser makes no probe');
  online = true;
  answer = () => json(410, RETIRED_BODY);
  const second = subject.probeSocket('ws://host/v1/socket', nothingToReport);
  release();
  await second;
  assert.equal(subject.retired, 'socket');
  clock.now += PROBE_SPACING_MS;
  await subject.probeSocket('ws://host/v1/socket', nothingToReport);
  assert.equal(calls.length, 2, 'a retired build probes no more');
});

test('the first door to say retired is the one counted, and a session enlisting later is retired at once', () => {
  const { subject, events } = retirement({ hidden: true });
  const early = new FakeSession();
  subject.enlist(early);
  subject.declare('write', nothingToReport);
  subject.declare('socket', nothingToReport);
  const late = new FakeSession();
  const unenlist = subject.enlist(late);
  assert.deepEqual({ retired: subject.retired, early: early.retired, late: late.retired }, { retired: 'write', early: 1, late: 1 });
  assert.deepEqual(events.filter(({ props }) => props.step === 'detected'), [{ name: 'roadmap_sync_retired', props: { step: 'detected', door: 'write' } }]);
  unenlist();
  assert.equal(subject.sessions.has(late), false);
});

test('a session that throws as it is retired is reported under its own name, and the rest are retired and reloaded', async () => {
  const failure = new Error('status handler failed');
  const { subject, page, events } = retirement({ hidden: true, fetch: async () => json(410, RETIRED_BODY) });
  const throwing = Object.assign(new FakeSession(), { retire() { throw failure; } });
  const second = new FakeSession();
  subject.enlist(throwing);
  subject.enlist(second);
  const reports = [];
  await subject.probeSocket('ws://localhost:8088/v1/socket', (...report) => reports.push(report));
  await settle();
  assert.deepEqual({ reports, second: second.retired, reloads: page.reloads }, { reports: [['roadmap-sync-retire', failure]], second: 1, reloads: 1 });
  assert.deepEqual(outcomes(events), ['detected', 'ran']);
});

test('a hidden page holding nothing reloads at once, after every session’s save reached the device', async () => {
  const log = [];
  const { subject, page, events } = retirement({ hidden: true });
  page.reload = () => log.push('reloaded');
  subject.enlist(new FakeSession(log));
  subject.enlist(new FakeSession(log));
  subject.declare('socket', nothingToReport);
  await settle();
  assert.deepEqual(log, ['saved', 'saved', 'reloaded']);
  assert.deepEqual(events, [
    { name: 'roadmap_sync_retired', props: { step: 'detected', door: 'socket' } },
    { name: 'roadmap_sync_retired', props: { step: 'reload', door: 'socket', outcome: 'ran' } },
  ]);
  assert.equal(page.watching, null);
});

test('a save that failed, or that stayed in the page’s memory, keeps the page offline with what it holds', async () => {
  const { subject, page, clock, events } = retirement({ hidden: true });
  const kept = new FakeSession();
  const lost = new FakeSession();
  lost.kept = false;
  subject.enlist(kept);
  subject.enlist(lost);
  subject.declare('socket', nothingToReport);
  await settle();
  clock.tick();
  await settle();
  assert.deepEqual({ reloads: page.reloads, watching: page.watching, timers: clock.timers.size }, { reloads: 0, watching: null, timers: 0 });
  assert.deepEqual(outcomes(events), ['detected', 'suppressed']);
});

test('a page in use waits for rest, and reloads on the first check that finds it', async () => {
  const { subject, page, clock, events } = retirement();
  subject.enlist(new FakeSession());
  subject.declare('write', nothingToReport);
  await settle();
  clock.tick();
  await settle();
  assert.equal(page.reloads, 0);
  page.rest = true;
  clock.tick();
  await settle();
  assert.equal(page.reloads, 1);
  assert.deepEqual(events.map(({ props }) => props), [
    { step: 'detected', door: 'write' },
    { step: 'reload', door: 'write', outcome: 'deferred' },
    { step: 'reload', door: 'write', outcome: 'ran' },
  ]);
  assert.equal(clock.timers.size, 0);
});

test('a draft, a text field, a dialog, a held act or a surface’s hold keeps the page from reloading even while it is hidden', async () => {
  for (const hold of ['page', 'act', 'surface']) {
    const { subject, page, clock, events } = retirement({ hidden: true, holdsWork: hold === 'page' });
    const session = new FakeSession();
    session.held = hold === 'act';
    const release = hold === 'surface' ? subject.hold() : () => {};
    subject.enlist(session);
    subject.declare('socket', nothingToReport);
    await settle();
    page.watching();
    clock.tick();
    await settle();
    assert.equal(page.reloads, 0, hold);
    page.held = false;
    session.held = false;
    release();
    page.watching();
    await settle();
    assert.equal(page.reloads, 1, hold);
    assert.deepEqual(outcomes(events), ['detected', 'deferred', 'ran'], hold);
  }
});

test('the page reloads only while a roadmap session is enlisted: the last to leave stops the watch, the next re-arms it', async () => {
  const { subject, page, clock, events } = retirement({ hidden: true });
  subject.declare('write', nothingToReport);
  await settle();
  assert.deepEqual({ reloads: page.reloads, watching: page.watching, timers: clock.timers.size }, { reloads: 0, watching: null, timers: 0 },
    'retired with no room open');
  const leave = subject.enlist(new FakeSession());
  assert.equal(typeof page.watching, 'function');
  page.held = true;
  clock.tick();
  await settle();
  leave();
  assert.deepEqual({ watching: page.watching, timers: clock.timers.size }, { watching: null, timers: 0 });
  page.held = false;
  clock.tick();
  await settle();
  assert.equal(page.reloads, 0, 'no room, no reload');
  subject.enlist(new FakeSession());
  page.watching();
  await settle();
  assert.equal(page.reloads, 1);
  assert.deepEqual(outcomes(events), ['detected', 'deferred', 'ran']);
});

test('the loop guard: inside the window the page stays offline until the window ends, then tries once more', async () => {
  const { subject, page, clock, events } = retirement({ hidden: true, reloadedAgo: 60_000 });
  subject.enlist(new FakeSession());
  subject.declare('socket', nothingToReport);
  await settle();
  assert.deepEqual({ reloads: page.reloads, watching: page.watching }, { reloads: 0, watching: null });
  clock.now += RELOAD_WINDOW_MS - 60_000 - 1;
  clock.tick();
  await settle();
  assert.equal(page.reloads, 0, 'still inside the window');
  clock.now += 1;
  clock.tick();
  await settle();
  assert.deepEqual({ reloads: page.reloads, markedAt: page.markedAt }, { reloads: 1, markedAt: clock.now });
  assert.deepEqual(outcomes(events), ['detected', 'suppressed', 'ran']);
});

test('the loop guard: a page that cannot keep the mark stays offline for good', async () => {
  const { subject, page, clock, events } = retirement({ hidden: true, keepsMarks: false });
  subject.enlist(new FakeSession());
  subject.declare('socket', nothingToReport);
  await settle();
  clock.now += RELOAD_WINDOW_MS * 3;
  clock.tick();
  await settle();
  assert.deepEqual({ reloads: page.reloads, watching: page.watching, timers: clock.timers.size }, { reloads: 0, watching: null, timers: 0 });
  assert.deepEqual(outcomes(events), ['detected', 'suppressed']);
});

class FakeStorage {
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, String(value)); }
}

class FakeTarget extends EventTarget {}

function pageWith({ activeElement = null, dialog = false, visibilityState = 'visible', storage = new FakeStorage(), clock = { now: 5_000_000 } } = {}) {
  const document = new FakeTarget();
  Object.assign(document, { activeElement, visibilityState, querySelector: () => (dialog ? {} : null) });
  const window = new FakeTarget();
  window.location = { reloads: 0, reload() { this.reloads += 1; } };
  return { page: new RetiredPage({ document, window, storage, now: () => clock.now }), document, window, clock };
}

test('a tab served the same retired build reloads once a window: suppressed on the next load, reloaded as the window ends', async () => {
  const clock = new Clock();
  const storage = new FakeStorage();
  const loadOf = () => {
    const shown = pageWith({ storage, clock, visibilityState: 'hidden' });
    const events = [];
    const subject = new BuildRetirement({ page: shown.page, timers: clock, now: () => clock.now, events: { track: (name, props) => events.push(props) } });
    subject.enlist(new FakeSession());
    return { ...shown, events, subject };
  };
  const first = loadOf();
  first.subject.declare('socket', nothingToReport);
  await settle();
  assert.equal(first.window.location.reloads, 1);
  clock.now += 60_000;
  const second = loadOf();
  second.subject.declare('socket', nothingToReport);
  await settle();
  assert.equal(second.window.location.reloads, 0);
  clock.now += RELOAD_WINDOW_MS;
  clock.tick();
  await settle();
  assert.equal(second.window.location.reloads, 1);
  assert.deepEqual(second.events.map(({ outcome, step }) => outcome ?? step), ['detected', 'suppressed', 'ran']);
});

test('the reload mark is read back as written, and a storage that keeps nothing keeps no mark', () => {
  const { page, clock } = pageWith();
  assert.equal(page.reloadMark(), null);
  assert.equal(page.markReload(), true);
  assert.equal(page.reloadMark(), clock.now);
  const forgetful = pageWith({ storage: { getItem: () => null, setItem: () => {} } }).page;
  assert.deepEqual({ marked: forgetful.markReload(), mark: forgetful.reloadMark() }, { marked: false, mark: null });
  const denied = () => { throw new DOMException('denied', 'SecurityError'); };
  const refusing = pageWith({ storage: { getItem: denied, setItem: denied } }).page;
  assert.deepEqual({ marked: refusing.markReload(), mark: refusing.reloadMark() }, { marked: false, mark: null });
});

test('what a reload would lose: a text field in focus, an open dialog, a step draft the guard holds', () => {
  const field = (tagName, type) => ({ tagName, type, isContentEditable: false });
  const holds = (options) => pageWith(options).page.holdsWork();
  assert.deepEqual({
    nothing: holds(),
    button: holds({ activeElement: field('BUTTON', 'button') }),
    checkbox: holds({ activeElement: field('INPUT', 'checkbox') }),
    text: holds({ activeElement: field('INPUT', 'text') }),
    search: holds({ activeElement: field('INPUT', 'search') }),
    textarea: holds({ activeElement: field('TEXTAREA', 'textarea') }),
    editable: holds({ activeElement: { tagName: 'DIV', isContentEditable: true } }),
    dialog: holds({ dialog: true }),
  }, { nothing: false, button: false, checkbox: false, text: true, search: true, textarea: true, editable: true, dialog: true });

  const { page, document } = pageWith();
  const drafts = stepDraftSession(document);
  drafts.bindScope({ getSnapshot: () => ({ phase: 'ready', epoch: 1, owner: 'u_fixture' }) });
  const token = drafts.start({ draft: { field: 'label', dirty: true }, treeId: 't_sail', route: {}, displayValue: 'Read gusts' });
  assert.equal(page.holdsWork(), true, 'an active draft');
  drafts.retain(token);
  assert.equal(page.holdsWork(), true, 'a retained draft');
  drafts.clear(token);
  assert.equal(page.holdsWork(), false);
});

test('between gestures: hidden, or no pointer pressed and no input for the idle stretch since watching began', () => {
  const { page, document, window, clock } = pageWith();
  const changes = [];
  const stop = page.watch(() => changes.push(document.visibilityState));
  assert.equal(page.resting(), false, 'watching begins as input');
  clock.now += IDLE_MS;
  assert.equal(page.resting(), true);
  window.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1 }));
  clock.now += IDLE_MS * 10;
  assert.equal(page.resting(), false, 'a pressed pointer');
  window.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 }));
  assert.equal(page.resting(), false, 'just released');
  clock.now += IDLE_MS;
  window.dispatchEvent(new Event('keydown'));
  assert.equal(page.resting(), false, 'a key');
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(page.resting(), true, 'hidden');
  assert.deepEqual(changes, ['hidden']);
  stop();
  document.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(changes, ['hidden']);
});

test('loading the module touches no session storage: the page it reloads is built when a build is first retired', async (t) => {
  let reads = 0;
  const keepsNothing = { getItem: () => null, setItem: () => {} };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { reads += 1; return keepsNothing; } });
  t.after(() => { delete globalThis.sessionStorage; });
  const fresh = await import(`../../../../src/products/roadmap/sync/retirement.js?load=${Date.now()}`);
  assert.equal(reads, 0);
  fresh.buildRetirement.declare('write', nothingToReport);
  assert.equal(reads, 1);
});
