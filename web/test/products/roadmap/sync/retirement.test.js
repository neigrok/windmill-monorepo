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
    this.intervals = new Map();
    this.next = 0;
  }
  setInterval(callback) { this.intervals.set(++this.next, callback); return this.next; }
  clearInterval(id) { this.intervals.delete(id); }
  tick() { for (const callback of [...this.intervals.values()]) callback(); }
}

class FakePage {
  constructor({ reloadedAt = null, keepsMarks = true, hidden = false, holdsWork = false, resting = false } = {}) {
    Object.assign(this, { reloadedAt, keepsMarks, hidden, held: holdsWork, rest: resting });
    this.reloads = 0;
    this.watching = null;
    this.marks = 0;
  }
  holdsWork() { return this.held; }
  resting() { return this.hidden || this.rest; }
  watch(onChange) { this.watching = onChange; return () => { this.watching = null; }; }
  reloadedWithin() { return this.reloadedAt !== null; }
  markReload() { this.marks += this.keepsMarks ? 1 : 0; return this.keepsMarks; }
  reload() { this.reloads += 1; }
}

class FakeSession {
  constructor(log = []) {
    this.log = log;
    this.retired = 0;
    this.held = false;
  }
  retire() { this.retired += 1; }
  holdsAct() { return this.held; }
  async persistNow() { this.log.push('persisted'); }
}

function retirement({ page = new FakePage(), fetch = async () => html(404, TODAYS_SOCKET_GET), online = () => true } = {}) {
  const clock = new Clock();
  const events = [];
  const subject = new BuildRetirement({
    page, fetch, online, timers: clock, now: () => clock.now,
    events: { track: (name, props) => events.push({ name, props }) },
  });
  return { subject, page, clock, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
  const report = () => assert.fail('nothing to report');
  const first = subject.probeSocket('ws://host/v1/socket', report);
  await subject.probeSocket('ws://host/v1/socket', report);
  release();
  await first;
  clock.now += PROBE_SPACING_MS - 1;
  await subject.probeSocket('ws://host/v1/socket', report);
  assert.equal(calls.length, 1, 'a reconnect loop inside the spacing makes no probe');
  online = false;
  clock.now += 1;
  await subject.probeSocket('ws://host/v1/socket', report);
  assert.equal(calls.length, 1, 'an offline browser makes no probe');
  online = true;
  answer = () => json(410, RETIRED_BODY);
  const second = subject.probeSocket('ws://host/v1/socket', report);
  release();
  await second;
  assert.equal(subject.retired, 'socket');
  clock.now += PROBE_SPACING_MS;
  await subject.probeSocket('ws://host/v1/socket', report);
  assert.equal(calls.length, 2, 'a retired build probes no more');
});

test('the first door to say retired is the one counted, and a session enlisting later is retired at once', () => {
  const { subject, events } = retirement({ page: new FakePage({ hidden: true }) });
  const early = new FakeSession();
  subject.enlist(early);
  subject.declare('write');
  subject.declare('socket');
  const late = new FakeSession();
  const unenlist = subject.enlist(late);
  assert.deepEqual({ retired: subject.retired, early: early.retired, late: late.retired }, { retired: 'write', early: 1, late: 1 });
  assert.deepEqual(events.filter(({ props }) => props.step === 'detected'), [{ name: 'roadmap_sync_retired', props: { step: 'detected', door: 'write' } }]);
  unenlist();
  assert.equal(subject.sessions.has(late), false);
});

test('a hidden page holding nothing reloads at once, after every session’s save', async () => {
  const log = [];
  const page = new FakePage({ hidden: true });
  page.reload = () => log.push('reloaded');
  const { subject, events } = retirement({ page });
  subject.enlist(new FakeSession(log));
  subject.enlist(new FakeSession(log));
  subject.declare('socket');
  await settle();
  assert.deepEqual(log, ['persisted', 'persisted', 'reloaded']);
  assert.deepEqual(events, [
    { name: 'roadmap_sync_retired', props: { step: 'detected', door: 'socket' } },
    { name: 'roadmap_sync_retired', props: { step: 'reload', door: 'socket', outcome: 'ran' } },
  ]);
  assert.equal(page.watching, null);
});

test('a page in use waits for rest, and reloads on the first check that finds it', async () => {
  const page = new FakePage();
  const { subject, clock, events } = retirement({ page });
  subject.declare('write');
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
  assert.deepEqual(clock.intervals.size, 0);
});

test('a draft, a text field, a dialog or a held act keeps the page from reloading even while it is hidden', async () => {
  for (const hold of ['page', 'act']) {
    const page = new FakePage({ hidden: true, holdsWork: hold === 'page' });
    const { subject, clock, events } = retirement({ page });
    const session = new FakeSession();
    session.held = hold === 'act';
    subject.enlist(session);
    subject.declare('socket');
    await settle();
    page.watching();
    clock.tick();
    await settle();
    assert.equal(page.reloads, 0, hold);
    page.held = false;
    session.held = false;
    page.watching();
    await settle();
    assert.equal(page.reloads, 1, hold);
    assert.deepEqual(events.map(({ props }) => props.outcome).filter(Boolean), ['deferred', 'ran'], hold);
  }
});

test('the loop guard: a tab that reloaded for this within the window, or cannot keep the mark, stays offline', async () => {
  for (const page of [new FakePage({ hidden: true, reloadedAt: 1 }), new FakePage({ hidden: true, keepsMarks: false })]) {
    const { subject, clock, events } = retirement({ page });
    const session = new FakeSession();
    subject.enlist(session);
    subject.declare('socket');
    await settle();
    assert.deepEqual({ reloads: page.reloads, watching: page.watching, timers: clock.intervals.size, retired: session.retired },
      { reloads: 0, watching: null, timers: 0, retired: 1 });
    assert.deepEqual(events.map(({ props }) => props), [
      { step: 'detected', door: 'socket' },
      { step: 'reload', door: 'socket', outcome: 'suppressed' },
    ]);
  }
});

class FakeStorage {
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.get(key) ?? null; }
  setItem(key, value) { this.items.set(key, String(value)); }
}

class FakeTarget extends EventTarget {}

function pageWith({ activeElement = null, dialog = false, visibilityState = 'visible', storage = new FakeStorage() } = {}) {
  const document = new FakeTarget();
  Object.assign(document, { activeElement, visibilityState, querySelector: () => (dialog ? {} : null) });
  const window = new FakeTarget();
  const clock = { now: 5_000_000 };
  return { page: new RetiredPage({ document, window, storage, now: () => clock.now }), document, window, clock };
}

test('the reload mark is kept for the window, and a storage that keeps nothing keeps no mark', () => {
  const { page, clock } = pageWith();
  assert.equal(page.reloadedWithin(RELOAD_WINDOW_MS), false);
  assert.equal(page.markReload(), true);
  clock.now += RELOAD_WINDOW_MS - 1;
  assert.equal(page.reloadedWithin(RELOAD_WINDOW_MS), true);
  clock.now += 1;
  assert.equal(page.reloadedWithin(RELOAD_WINDOW_MS), false);
  const forgetful = pageWith({ storage: { getItem: () => null, setItem: () => {} } }).page;
  assert.equal(forgetful.markReload(), false);
  const refusing = pageWith({ storage: { getItem: () => { throw new DOMException('denied', 'SecurityError'); }, setItem: () => { throw new DOMException('denied', 'SecurityError'); } } }).page;
  assert.deepEqual({ within: refusing.reloadedWithin(RELOAD_WINDOW_MS), marked: refusing.markReload() }, { within: false, marked: false });
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
