import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationCoordinator } from '../../src/shell/navigation.js';
import { navigationBrowser } from './navigationBrowser.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('admission retains the first destination and exposes complete compound metadata once', async (t) => {
  const { browser, entries } = navigationBrowser(t, { state: { unknown: { kept: true }, boardStep: { trail: ['wind'], pushed: 1 } } });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const notices = [];
  const published = [];
  nav.subscribe((entry) => published.push(entry));
  nav.register({ blocked: () => true, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() {} });
  let calls = 0;
  const run = (tx) => {
    calls += 1;
    tx.updateState((state) => ({ ...state, roadmapWentThrough: { stepId: 'wind' } }));
    tx.navigate('#/app/other');
    tx.updateState((state) => ({ ...state, roadmapCameFrom: { treeId: 'sail' } }));
    return 42;
  };
  const result = nav.request({ key: 'tree:other', run });
  assert.equal(nav.request({ key: 'tree:other', run }), result);
  assert.deepEqual(await nav.request({ key: 'tree:third', run }), { status: 'cancelled' });
  assert.deepEqual({ calls, entries: entries.length, publications: published.length, notices: notices.length }, { calls: 0, entries: 1, publications: 0, notices: 1 });
  notices[0].proceed();
  notices[0].proceed();
  notices[0].cancel();
  assert.deepEqual(await result, { status: 'completed', value: 42 });
  assert.equal(calls, 1);
  assert.equal(published.length, 1);
  assert.deepEqual(entries[0].state.unknown, { kept: true });
  assert.deepEqual(entries[0].state.boardStep, { trail: ['wind'], pushed: 1 });
  assert.deepEqual(published[0].state.roadmapCameFrom, { treeId: 'sail' });
  assert.deepEqual(published[0].state.windmillNavigation, { href: '/app/roadmap#/app/other', previous: '/app/roadmap#/app/sail' });
});

test('cancel, release and stale decisions cannot replay an action; async rejection releases admission', async (t) => {
  const { browser } = navigationBrowser(t);
  const failures = [];
  const nav = createNavigationCoordinator(browser, { report: (operation) => failures.push(operation) });
  t.after(() => nav.dispose());
  let notice;
  let calls = 0;
  const release = nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  const first = nav.request({ key: 'first', run: () => { calls += 1; } });
  notice.cancel();
  notice.proceed();
  assert.deepEqual(await first, { status: 'cancelled' });
  const second = nav.request({ key: 'second', run: () => { calls += 1; } });
  release();
  notice.proceed();
  assert.deepEqual(await second, { status: 'cancelled' });
  assert.equal(calls, 0);
  nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() {} });
  let reject;
  const failed = nav.request({ key: 'async', run: () => new Promise((resolve, fail) => { reject = fail; }) });
  assert.deepEqual(await nav.request({ key: 'other', run: () => { calls += 1; } }), { status: 'cancelled' });
  reject(new Error('private content stays outside reports'));
  assert.deepEqual(await failed, { status: 'cancelled' });
  assert.deepEqual(failures, ['navigation-commit']);
  assert.deepEqual(await nav.request({ key: 'next', run: () => 7 }), { status: 'completed', value: 7 });
});

test('indexed Back restores before asking; cancel preserves Forward; proceed matches same-URL identity', async (t) => {
  const { browser, entries } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'selection', run: (tx) => tx.pushEntry(tx.read().href, { ...tx.read().state, boardSelection: { token: 'selection', kinds: false } }) });
  const selected = nav.read();
  await nav.request({ key: 'kinds', run: (tx) => tx.pushEntry(tx.read().href, { ...tx.read().state, boardSelection: { token: 'selection', kinds: true } }) });
  const origin = nav.read();
  const publications = [];
  nav.subscribe((entry) => publications.push(entry));
  let notice;
  nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() { assert.fail('indexed entries are restorable'); } });
  browser.history.back();
  await tick();
  assert.equal(browser.history.state.windmillHistory.entryId, origin.state.windmillHistory.entryId);
  assert.equal(nav.read(), origin);
  assert.equal(publications.length, 0);
  notice.cancel();
  browser.history.back();
  await tick();
  notice.proceed();
  await tick();
  assert.equal(nav.read().state.windmillHistory.entryId, selected.state.windmillHistory.entryId);
  assert.equal(publications.length, 1);
  browser.history.forward();
  await tick();
  notice.proceed();
  await tick();
  assert.equal(nav.read().state.windmillHistory.entryId, origin.state.windmillHistory.entryId);
  assert.equal(entries.length, 3);
});

test('repeated native attempts restore to the same origin and keep the first target', async (t) => {
  const { browser, traversals, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  for (const key of ['second', 'third']) await nav.request({ key, run: (tx) => tx.navigate(`#/${key}`) });
  const origin = nav.read();
  const notices = [];
  nav.register({ blocked: () => true, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() { assert.fail('known chain'); } });
  browser.history.back(); flush(); flush();
  await tick();
  browser.history.go(-2); flush();
  assert.equal(traversals.length, 1);
  notices[0].proceed();
  flush(); await tick();
  assert.equal(notices.length, 1);
  flush(); await tick();
  assert.equal(nav.read().hash, '#/second');
  assert.equal(nav.read().state.windmillHistory.position, origin.state.windmillHistory.position - 1);
});

test('unknown navigation retains synchronously, invalidates the token, coalesces events and starts a fresh chain', async (t) => {
  const { browser, nativeHash } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const origin = nav.read();
  const order = [];
  let notice;
  let calls = 0;
  nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() { order.push(['retain', nav.read().href]); } });
  nav.subscribe((entry) => order.push(['publish', entry.href]));
  const result = nav.request({ key: 'pending', run: () => { calls += 1; } });
  nativeHash('#/native', { unknown: 'preserved' });
  notice.proceed();
  assert.deepEqual(await result, { status: 'cancelled' });
  assert.equal(calls, 0);
  assert.deepEqual(order, [['retain', origin.href], ['publish', 'https://windmill.works/app/roadmap#/native']]);
  assert.notEqual(nav.read().state.windmillHistory.chain, origin.state.windmillHistory.chain);
  assert.equal(nav.read().state.windmillHistory.position, 0);
  assert.equal(nav.read().state.unknown, 'preserved');
});

test('retention failure keeps the accepted owner; failed restore is bounded and uses retention before publication', async (t) => {
  const { browser, nativeHash } = navigationBrowser(t);
  const failures = [];
  const nav = createNavigationCoordinator(browser, { timeout: 10, report: (operation) => failures.push(operation) });
  t.after(() => nav.dispose());
  const origin = nav.read();
  let retains = 0;
  let publications = 0;
  const release = nav.register({ blocked: () => true, onBlocked() {}, onUnrestorableNavigation() { retains += 1; throw new Error('draft secret'); } });
  nav.subscribe(() => { publications += 1; });
  nativeHash('#/unknown');
  assert.equal(nav.read(), origin);
  assert.deepEqual({ retains, publications, failures }, { retains: 1, publications: 0, failures: ['navigation-retain'] });
  assert.deepEqual(await nav.request({ key: 'blocked', run: () => assert.fail() }), { status: 'cancelled' });
  release();

  const other = navigationBrowser(t, { install: false });
  const timed = createNavigationCoordinator(other.browser, { timeout: 10, report: (operation) => failures.push(operation) });
  t.after(() => timed.dispose());
  await timed.request({ key: 'next', run: (tx) => tx.navigate('#/next') });
  const order = [];
  timed.register({ blocked: () => true, onBlocked() { assert.fail('restore never completed'); }, onUnrestorableNavigation() { order.push('retain'); } });
  timed.subscribe(() => order.push('publish'));
  const back = other.browser.history.go.bind(other.browser.history);
  other.browser.history.go = (delta) => { if (delta < 0) back(delta); };
  other.browser.history.back();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ['retain', 'publish']);
  assert.deepEqual(failures, ['navigation-retain', 'navigation-restore']);
});

test('Back during a voluntary decision restores the origin without replacing the retained action', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'second', run: (tx) => tx.navigate('#/second') });
  const origin = nav.read();
  const notices = [];
  nav.register({ blocked: () => true, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'settings', run: (tx) => tx.navigate('/app/settings') });
  browser.history.back();
  await tick();
  assert.equal(notices.length, 1);
  assert.equal(nav.read(), origin);
  notices[0].proceed();
  assert.deepEqual(await result, { status: 'completed', value: undefined });
  assert.equal(nav.read().pathname, '/app/settings');
});

test('a branch push uses a fresh identity and replacements retain index plus unowned metadata', async (t) => {
  const { browser, entries } = navigationBrowser(t, { state: { unknown: 7 } });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const root = nav.read().state.windmillHistory;
  await nav.request({ key: 'one', run: (tx) => tx.pushEntry('#/one', { ...tx.read().state, own: true }) });
  const oldBranch = nav.read().state.windmillHistory;
  await nav.request({ key: 'back', run: (tx) => tx.traverse(-1) });
  await nav.request({ key: 'two', run: (tx) => {
    tx.pushEntry('#/two', { ...tx.read().state, own: true });
    tx.updateState(({ own, ...state }) => ({ ...state, replaced: true }));
  } });
  const current = nav.read().state;
  assert.deepEqual({ unknown: current.unknown, own: current.own, replaced: current.replaced, position: current.windmillHistory.position, chain: current.windmillHistory.chain }, { unknown: 7, own: undefined, replaced: true, position: root.position + 1, chain: root.chain });
  assert.notEqual(current.windmillHistory.entryId, oldBranch.entryId);
  assert.equal(entries.length, 2);
});

test('an observer failure reports a static operation and does not suppress other accepted readers', async (t) => {
  const { browser } = navigationBrowser(t);
  const failures = [];
  const nav = createNavigationCoordinator(browser, { report: (operation) => failures.push(operation) });
  t.after(() => nav.dispose());
  const seen = [];
  nav.subscribe(() => { throw new Error('private content'); });
  nav.subscribe((entry) => seen.push(entry.pathname));
  assert.deepEqual(await nav.request({ key: 'settings', run: (tx) => tx.navigate('/app/settings') }), { status: 'completed', value: undefined });
  assert.deepEqual(seen, ['/app/settings']);
  assert.deepEqual(failures, ['navigation-observer']);
});


test('without a registered guard, later navigation proceeds during an asynchronous action', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const origin = nav.read().href;
  let finish;
  let started = false;
  const deletion = nav.request({ key: 'delete', run: async (tx) => {
    started = true;
    await new Promise((resolve) => { finish = resolve; });
    if (nav.read().href !== origin) return 'left';
    tx.navigate('#/after-delete');
    return 'deleted';
  } });
  assert.equal(started, true);
  assert.deepEqual(await nav.request({ key: 'browse', run: (tx) => tx.navigate('#/browse') }), { status: 'completed', value: undefined });
  finish();
  assert.deepEqual(await deletion, { status: 'completed', value: 'left' });
  assert.equal(nav.read().hash, '#/browse');
});

test('system reconciliation waits for its accepted identity and never rewrites a transient entry', async (t) => {
  const { browser, entries, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'next', run: (tx) => tx.navigate('#/next') });
  const origin = nav.read();
  let notice;
  nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  browser.history.back(); flush();
  const transient = structuredClone(entries[0].state);
  let writes = 0;
  nav.system((tx) => { writes += 1; tx.updateState((state) => ({ ...state, reconciled: true })); });
  assert.equal(writes, 0);
  assert.deepEqual(entries[0].state, transient);
  flush(); await tick();
  assert.equal(writes, 1);
  assert.equal(nav.read().state.reconciled, true);
  assert.equal(nav.read().state.windmillHistory.entryId, origin.state.windmillHistory.entryId);
  assert.deepEqual(entries[0].state, transient);
  notice.cancel();
  browser.history.back(); flush(); flush(); await tick();
  assert.equal(writes, 1);
});

test('an approved departure or unknown acceptance discards a deferred rewrite for the old accepted entry', async (t) => {
  for (const outcome of ['proceed', 'unknown']) {
    const { browser, flush, nativeHash } = navigationBrowser(t, { deferred: true, install: false });
    const nav = createNavigationCoordinator(browser);
    t.after(() => nav.dispose());
    await nav.request({ key: 'next', run: (tx) => tx.navigate('#/next') });
    let notice;
    nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
    browser.history.back(); flush(); flush(); await tick();
    browser.history.back(); flush();
    let writes = 0;
    nav.system((tx) => { writes += 1; tx.navigate('#/stale', { replace: true }); });
    if (outcome === 'unknown') nativeHash('#/unknown');
    else { notice.proceed(); flush(); await tick(); flush(); await tick(); }
    assert.equal(writes, 0);
    assert.equal(nav.read().hash, outcome === 'unknown' ? '#/unknown' : '#/app/sail');
  }
});

test('a failed guard predicate refuses automatic admission and reports no exception content', async (t) => {
  const { browser } = navigationBrowser(t);
  const failures = [];
  const nav = createNavigationCoordinator(browser, { report: (operation) => failures.push(operation) });
  t.after(() => nav.dispose());
  nav.register({ blocked() { throw new Error('private draft'); }, onBlocked: ({ cancel }) => cancel(), onUnrestorableNavigation() {} });
  assert.deepEqual(await nav.request({ key: 'private destination', run: () => assert.fail('predicate failure must not admit') }), { status: 'cancelled' });
  assert.deepEqual(failures, ['navigation-guard']);
});

test('releasing an earlier registration cannot release a later registration of the same callbacks', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  let notice;
  let calls = 0;
  const guard = { blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} };
  const releaseFirst = nav.register(guard);
  releaseFirst();
  const releaseSecond = nav.register(guard);
  const result = nav.request({ key: 'later', run: () => { calls += 1; } });
  releaseFirst();
  notice.proceed();
  assert.deepEqual(await result, { status: 'completed', value: undefined });
  assert.equal(calls, 1);
  releaseSecond();
});

test('an admitted async action survives its guard release during native restoration', async (t) => {
  const { browser, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  let notice;
  const release = nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  let finish;
  const result = nav.request({ key: 'sign-out', run: async (tx) => {
    await new Promise((resolve) => { finish = resolve; });
    tx.navigate('/app', { replace: true });
    return true;
  } });
  notice.proceed();
  browser.history.back(); flush();
  release();
  flush(); await tick();
  finish();
  assert.deepEqual(await result, { status: 'completed', value: true });
  assert.equal(nav.read().pathname, '/app');
});

test('Proceed consumes the decision while its asynchronous action awaits', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  let notice;
  let finish;
  let calls = 0;
  nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'async', run: async (tx) => {
    calls += 1;
    await new Promise((resolve) => { finish = resolve; });
    tx.navigate('#/finished');
    return 7;
  } });
  notice.proceed(); notice.cancel(); notice.proceed(); finish();
  assert.deepEqual(await result, { status: 'completed', value: 7 });
  assert.deepEqual({ calls, actual: browser.location.hash, accepted: nav.read().hash }, { calls: 1, actual: '#/finished', accepted: '#/finished' });
});

test('an admitted compound action buffers update, push and replace until its exact origin returns', async (t) => {
  const { browser, entries, flush } = navigationBrowser(t, { deferred: true, state: { prior: true } });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.pushEntry('#/origin', { origin: true }) });
  const prior = { href: entries[0].url.href, state: structuredClone(entries[0].state) };
  const origin = nav.read();
  const seen = [];
  nav.subscribe((entry) => seen.push(entry));
  let notice;
  let finish;
  let working;
  let settled = false;
  nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'compound', run: async (tx) => {
    await new Promise((resolve) => { finish = resolve; });
    tx.updateState((state) => ({ ...state, departure: true }));
    tx.pushEntry('#/destination', { arrival: true });
    tx.updateState((state) => ({ ...state, complete: true }));
    tx.replaceEntry('/app/finished', { ...tx.read().state, replaced: true });
    working = tx.read();
    return 'done';
  } });
  result.then(() => { settled = true; });
  notice.proceed(); browser.history.back(); flush(); finish(); await tick();
  assert.deepEqual({ settled, count: entries.length, publications: seen.length, actual: browser.location.href, accepted: nav.read().href },
    { settled: false, count: 2, publications: 0, actual: prior.href, accepted: origin.href });
  assert.deepEqual({ href: entries[0].url.href, state: entries[0].state }, prior);
  assert.deepEqual(entries[1].state, origin.state);
  assert.deepEqual(working.state, { arrival: true, complete: true, replaced: true, windmillHistory: {
    chain: origin.state.windmillHistory.chain, position: 2, entryId: working.state.windmillHistory.entryId,
  } });
  flush(); await tick();
  assert.deepEqual(await result, { status: 'completed', value: 'done' });
  assert.equal(seen.length, 1);
  assert.equal(nav.read().href, browser.location.href);
  assert.deepEqual(nav.read().state, working.state);
  assert.deepEqual(entries[1].state, { ...origin.state, departure: true });
  assert.deepEqual({ href: entries[0].url.href, state: entries[0].state }, prior);
  assert.notEqual(working.state.windmillHistory.entryId, origin.state.windmillHistory.entryId);
});

test('unknown, failed and same-position wrong-identity restoration revoke parked writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['unknown', 'timeout', 'impostor']) {
    const { browser, entries, flush, nativeHash } = navigationBrowser(t, { deferred: true, install: false });
    const reports = [];
    const order = [];
    const nav = createNavigationCoordinator(browser, { timeout: 100, report: (operation) => reports.push(operation) });
    t.after(() => nav.dispose());
    await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
    const origin = nav.read();
    let finish;
    nav.register({ blocked: () => true, onBlocked: ({ proceed }) => proceed(), onUnrestorableNavigation() { order.push('retain'); } });
    nav.subscribe(() => order.push('publish'));
    const result = nav.request({ key: 'async', run: async (tx) => {
      await new Promise((resolve) => { finish = resolve; });
      tx.updateState((state) => ({ ...state, forbidden: true }));
      tx.navigate('#/forbidden');
    } });
    browser.history.back(); flush(); finish(); await tick();
    assert.deepEqual(order, []);
    if (outcome === 'unknown') nativeHash('#/unknown');
    if (outcome === 'timeout') t.mock.timers.tick(100);
    if (outcome === 'impostor') {
      entries[1].state = { ...entries[1].state, windmillHistory: { ...origin.state.windmillHistory, entryId: 'different-entry' } };
      flush();
    }
    assert.deepEqual(await result, { status: 'cancelled' });
    assert.deepEqual(order, ['retain', 'publish']);
    assert.equal(nav.read().href, browser.location.href);
    assert.notEqual(nav.read().state.windmillHistory.chain, origin.state.windmillHistory.chain);
    assert.equal(entries.some((entry) => entry.state?.forbidden || entry.url.hash === '#/forbidden'), false);
    assert.deepEqual(reports, outcome === 'timeout' ? ['navigation-restore'] : []);
    nav.dispose();
  }
});

test('two and several queued Back calls restore from observed positions without losing the first target', async (t) => {
  for (const count of [2, 4]) {
    const { browser, traversals, flush } = navigationBrowser(t, { deferred: true, install: false });
    const reports = [];
    const notices = [];
    const nav = createNavigationCoordinator(browser, { report: (operation) => reports.push(operation) });
    t.after(() => nav.dispose());
    for (let i = 1; i <= 6; i += 1) await nav.request({ key: String(i), run: (tx) => tx.navigate(`#/${i}`) });
    const origin = nav.read();
    let retains = 0;
    nav.register({ blocked: () => true, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() { retains += 1; } });
    for (let i = 0; i < count; i += 1) browser.history.back();
    for (let i = 0; traversals.length && i < 30; i += 1) { flush(); await tick(); }
    assert.deepEqual({ actual: browser.location.href, accepted: nav.read().href, notices: notices.length, retains, reports, queued: traversals.length },
      { actual: origin.href, accepted: origin.href, notices: 1, retains: 0, reports: [], queued: 0 });
    notices[0].proceed(); flush(); await tick();
    assert.equal(nav.read().hash, '#/5');
  }
});

test('interleaved Back and Forward retain one deadline and fall back safely under continued interference', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { browser, entries, traversals, flush } = navigationBrowser(t, { deferred: true });
  const reports = [];
  const order = [];
  const nav = createNavigationCoordinator(browser, { timeout: 100, report: (operation) => reports.push(operation) });
  t.after(() => nav.dispose());
  for (let i = 1; i <= 4; i += 1) await nav.request({ key: String(i), run: (tx) => tx.navigate(`#/${i}`) });
  const origin = nav.read();
  nav.register({ blocked: () => true, onBlocked() { assert.fail('origin has not been restored'); }, onUnrestorableNavigation() { order.push('retain'); } });
  nav.subscribe(() => order.push('publish'));
  browser.history.back(); browser.history.back(); browser.history.forward(); browser.history.back();
  flush(); t.mock.timers.tick(30); flush(); t.mock.timers.tick(30); flush(); t.mock.timers.tick(30); flush();
  assert.deepEqual(order, []);
  assert.ok(traversals.length > 0);
  t.mock.timers.tick(10);
  await tick();
  assert.deepEqual({ order, reports }, { order: ['retain', 'publish'], reports: ['navigation-restore'] });
  assert.equal(nav.read().href, browser.location.href);
  assert.notEqual(nav.read().state.windmillHistory.chain, origin.state.windmillHistory.chain);
  assert.equal(entries.length, 5);
});

test('a late native event after apparent restoration must restore again before asking', async (t) => {
  const { browser, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  const origin = nav.read();
  const notices = [];
  nav.register({ blocked: () => true, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() {} });
  browser.history.back(); flush(); flush();
  browser.history.back(); flush();
  await tick();
  assert.equal(notices.length, 0);
  assert.notEqual(browser.location.href, origin.href);
  flush(); await tick();
  assert.deepEqual({ notices: notices.length, actual: browser.location.href, accepted: nav.read().href }, { notices: 1, actual: origin.href, accepted: origin.href });
});

test('a rejected async action reports after unknown navigation revokes its capability', async (t) => {
  const { browser, nativeHash } = navigationBrowser(t);
  const reports = [];
  const nav = createNavigationCoordinator(browser, { report: (...args) => reports.push(args) });
  t.after(() => nav.dispose());
  let reject;
  let tx;
  nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'private-key', run: (transaction) => {
    tx = transaction;
    return new Promise((resolve, fail) => { reject = fail; });
  } });
  nativeHash('#/unknown');
  assert.deepEqual(await result, { status: 'cancelled' });
  const accepted = nav.read();
  tx.navigate('#/revoked');
  reject(new Error('private payload'));
  await tick();
  assert.equal(nav.read(), accepted);
  assert.equal(browser.location.href, accepted.href);
  assert.deepEqual(reports, [['navigation-commit']]);
});

test('an unguarded async action owns its snapshot only when its first history write begins', async (t) => {
  const { browser, entries } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  let finish;
  const result = nav.request({ key: 'async', run: async (tx) => {
    await new Promise((resolve) => { finish = resolve; });
    tx.updateState((state) => ({ ...state, late: true }));
    tx.navigate('#/finish');
  } });
  await nav.request({ key: 'later', run: (tx) => tx.pushEntry('#/later', { current: true }) });
  const later = nav.read();
  finish();
  assert.deepEqual(await result, { status: 'completed', value: undefined });
  assert.deepEqual(entries[1].state, { ...later.state, late: true });
  assert.deepEqual(nav.read().state.windmillNavigation, { href: '/app/roadmap#/finish', previous: '/app/roadmap#/later' });
  assert.equal(nav.read().state.windmillHistory.position, 2);
  assert.equal(nav.read().href, browser.location.href);
});

test('releasing a guard cannot revoke Proceed while physical restoration delays the action', async (t) => {
  const { browser, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  let notice;
  let calls = 0;
  const release = nav.register({ blocked: () => true, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'later', run: (tx) => { calls += 1; tx.navigate('#/later'); } });
  browser.history.back(); flush(); notice.proceed(); release();
  assert.equal(calls, 0);
  flush(); await tick();
  assert.deepEqual(await result, { status: 'completed', value: undefined });
  assert.deepEqual({ calls, actual: browser.location.hash, accepted: nav.read().hash }, { calls: 1, actual: '#/later', accepted: '#/later' });
});

test('an async action restores its already-applied working entry before finishing', async (t) => {
  const { browser, flush, entries } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  let finish;
  const seen = [];
  const origin = nav.read();
  nav.subscribe((entry) => seen.push(entry));
  nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() { assert.fail('working entry is indexed'); } });
  const result = nav.request({ key: 'async', run: async (tx) => {
    tx.navigate('#/working');
    await new Promise((resolve) => { finish = resolve; });
    tx.updateState((state) => ({ ...state, complete: true }));
  } });
  const workingId = browser.history.state.windmillHistory.entryId;
  browser.history.back(); flush(); finish(); await tick();
  assert.equal(nav.read(), origin);
  assert.equal(seen.length, 0);
  flush(); await tick();
  assert.deepEqual(await result, { status: 'completed', value: undefined });
  assert.deepEqual({ actual: browser.location.hash, accepted: nav.read().hash, count: seen.length, entries: entries.length, complete: nav.read().state.complete, id: nav.read().state.windmillHistory.entryId },
    { actual: '#/working', accepted: '#/working', count: 1, entries: 2, complete: true, id: workingId });
});

test('a failed buffered history mutation reports once and does not retry the rejected write', async (t) => {
  const { browser, flush } = navigationBrowser(t, { deferred: true });
  const reports = [];
  const nav = createNavigationCoordinator(browser, { report: (...args) => reports.push(args) });
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  const origin = nav.read();
  let finish;
  let attempts = 0;
  const replace = browser.history.replaceState;
  browser.history.replaceState = (state, unused, href) => {
    if (state.rejected) { attempts += 1; throw new Error('private write failure'); }
    replace(state, unused, href);
  };
  nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'async', run: async (tx) => {
    await new Promise((resolve) => { finish = resolve; });
    tx.updateState((state) => ({ ...state, rejected: true }));
  } });
  browser.history.back(); flush(); finish(); await tick(); flush(); await tick();
  assert.deepEqual(await result, { status: 'cancelled' });
  assert.deepEqual({ attempts, reports, actual: browser.location.href, accepted: nav.read().href },
    { attempts: 1, reports: [['navigation-commit']], actual: origin.href, accepted: origin.href });
});

test('a zero-effect result settles before another action finishes traversing', async (t) => {
  const { browser, flush } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  let finish;
  let completion;
  const result = nav.request({ key: 'async', run: async () => {
    await new Promise((resolve) => { finish = resolve; });
    return 7;
  } });
  result.then((value) => { completion = value; });
  const back = nav.request({ key: 'back', run: (tx) => tx.traverse(-1) });
  finish(); await tick();
  assert.deepEqual(completion, { status: 'completed', value: 7 });
  assert.equal(browser.location.hash, '#/origin');
  flush(); await tick();
  assert.deepEqual(await back, { status: 'completed', value: true });
  assert.equal(nav.read().href, browser.location.href);
});

test('an old action cannot claim history while another action owns a traversal', async (t) => {
  const { browser, flush, entries } = navigationBrowser(t, { deferred: true });
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const origin = nav.read();
  await nav.request({ key: 'next', run: (tx) => tx.navigate('#/next') });
  const seen = [];
  nav.subscribe((entry) => seen.push(entry));
  let finish;
  const old = nav.request({ key: 'async', run: async (tx) => {
    await new Promise((resolve) => { finish = resolve; });
    tx.navigate('#/obsolete');
    return 7;
  } });
  const back = nav.request({ key: 'back', run: (tx) => tx.traverse(-1) });
  finish(); await tick();
  assert.deepEqual(await old, { status: 'cancelled' });
  assert.equal(seen.length, 0);
  flush(); await tick();
  assert.deepEqual(await back, { status: 'completed', value: true });
  assert.deepEqual({ accepted: nav.read().href, actual: browser.location.href, publications: seen.length, entries: entries.length },
    { accepted: origin.href, actual: origin.href, publications: 1, entries: 2 });
});

test('failure keeps admission until already-applied history is restored and published', async (t) => {
  const { browser, flush, entries } = navigationBrowser(t, { deferred: true });
  const reports = [];
  const order = [];
  const nav = createNavigationCoordinator(browser, { report: (...args) => reports.push(args) });
  t.after(() => nav.dispose());
  const prior = nav.read();
  let reject;
  let tx;
  nav.register({ blocked: () => false, onBlocked() {}, onUnrestorableNavigation() {} });
  nav.subscribe((entry) => order.push(['publish', entry.hash]));
  const result = nav.request({ key: 'async', run: (transaction) => {
    tx = transaction;
    tx.navigate('#/working');
    return new Promise((resolve, fail) => { reject = fail; });
  } });
  const working = structuredClone(browser.history.state);
  result.then((value) => order.push(['settle', value]));
  browser.history.back(); flush();
  tx.navigate('#/unapplied');
  reject(new Error('private failure')); await tick();
  assert.deepEqual(order, []);
  assert.deepEqual(reports, [['navigation-commit']]);
  assert.deepEqual(await nav.request({ key: 'competing', run: () => assert.fail('failed work still owns its applied history') }), { status: 'cancelled' });
  tx.navigate('#/after-failure');
  flush(); await tick();
  assert.deepEqual(await result, { status: 'cancelled' });
  assert.deepEqual(order, [['publish', '#/working'], ['settle', { status: 'cancelled' }]]);
  assert.deepEqual({ href: nav.read().href, state: nav.read().state }, { href: browser.location.href, state: working });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].state, prior.state);
});

test('newer navigation owns publication when an older applied action succeeds or fails', async (t) => {
  for (const outcome of ['success', 'failure']) {
    const { browser, entries } = navigationBrowser(t, { install: false });
    const reports = [];
    const nav = createNavigationCoordinator(browser, { report: (operation) => reports.push(operation) });
    t.after(() => nav.dispose());
    let resolve;
    let reject;
    const old = nav.request({ key: 'old', run: (tx) => {
      tx.navigate('#/old');
      return new Promise((done, fail) => { resolve = done; reject = fail; });
    } });
    const seen = [];
    nav.subscribe((entry) => seen.push(entry));
    await nav.request({ key: 'new', run: (tx) => {
      tx.navigate('#/new');
      tx.updateState((state) => ({ ...state, current: true }));
    } });
    const current = nav.read();
    if (outcome === 'success') resolve(7);
    else reject(new Error('private failure'));
    assert.deepEqual(await old, { status: 'cancelled' });
    assert.equal(nav.read(), current);
    assert.deepEqual({ href: browser.location.href, publications: seen.length, entries: entries.length, previous: current.state.windmillNavigation.previous },
      { href: current.href, publications: 1, entries: 3, previous: '/app/roadmap#/old' });
    assert.deepEqual(reports, outcome === 'failure' ? ['navigation-commit'] : []);
  }
});

test('fallback and disposal settle every action and late rejection cannot revive history', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const fallback of ['unknown', 'timeout', 'dispose']) {
    const { browser, flush, nativeHash } = navigationBrowser(t, { deferred: true, install: false });
    const reports = [];
    const nav = createNavigationCoordinator(browser, { timeout: 100, report: (...args) => reports.push(args) });
    t.after(() => nav.dispose());
    await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
    let reject;
    let tx;
    const old = nav.request({ key: 'old', run: (transaction) => {
      tx = transaction;
      return new Promise((resolve, fail) => { reject = fail; });
    } });
    const back = nav.request({ key: 'back', run: (transaction) => transaction.traverse(-1) });
    if (fallback === 'unknown') nativeHash('#/unknown');
    if (fallback === 'timeout') t.mock.timers.tick(100);
    if (fallback === 'dispose') nav.dispose();
    assert.deepEqual(await Promise.all([old, back]), [{ status: 'cancelled' }, { status: 'cancelled' }]);
    const current = nav.read();
    tx.navigate('#/revoked');
    reject(new Error('private failure')); await tick();
    assert.equal(nav.read(), current);
    assert.equal(nav.read().href, browser.location.href);
    assert.deepEqual(reports, fallback === 'timeout' ? [['navigation-traverse'], ['navigation-commit']] : [['navigation-commit']]);
    if (fallback !== 'dispose') { flush(); await tick(); assert.notEqual(nav.read().hash, '#/revoked'); }
  }
});

test('failure during restoration settles on unknown, timeout or disposal without replaying unapplied work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const fallback of ['unknown', 'timeout', 'dispose']) {
    const { browser, entries, flush, nativeHash } = navigationBrowser(t, { deferred: true, install: false });
    const order = [];
    const reports = [];
    const nav = createNavigationCoordinator(browser, { timeout: 100, report: (operation) => reports.push(operation) });
    t.after(() => nav.dispose());
    let reject;
    let tx;
    nav.register({ blocked: () => true, onBlocked: ({ proceed }) => proceed(), onUnrestorableNavigation: () => order.push('retain') });
    nav.subscribe(() => order.push('publish'));
    const result = nav.request({ key: 'failed', run: (transaction) => {
      tx = transaction;
      tx.navigate('#/working');
      return new Promise((resolve, fail) => { reject = fail; });
    } });
    result.then(() => order.push('settle'));
    browser.history.back(); flush(); tx.navigate('#/unapplied'); reject(new Error('private failure')); await tick();
    assert.deepEqual(order, []);
    if (fallback === 'unknown') nativeHash('#/unknown');
    if (fallback === 'timeout') t.mock.timers.tick(100);
    if (fallback === 'dispose') nav.dispose();
    assert.deepEqual(await result, { status: 'cancelled' });
    await tick();
    assert.deepEqual(order, fallback === 'dispose' ? ['settle'] : ['retain', 'publish', 'settle']);
    assert.deepEqual(reports, fallback === 'timeout' ? ['navigation-commit', 'navigation-restore'] : ['navigation-commit']);
    assert.equal(entries.some((entry) => entry.url.hash === '#/unapplied'), false);
    if (fallback !== 'dispose') assert.equal(nav.read().href, browser.location.href);
  }
});

test('a guard callback failure after Proceed cannot revoke its admitted action', async (t) => {
  const { browser } = navigationBrowser(t);
  const reports = [];
  const nav = createNavigationCoordinator(browser, { report: (operation) => reports.push(operation) });
  t.after(() => nav.dispose());
  let finish;
  nav.register({ blocked: () => true, onBlocked({ proceed }) { proceed(); throw new Error('private guard failure'); }, onUnrestorableNavigation() {} });
  const result = nav.request({ key: 'async', run: async (tx) => {
    tx.navigate('#/working');
    await new Promise((resolve) => { finish = resolve; });
    return 7;
  } });
  finish();
  assert.deepEqual(await result, { status: 'completed', value: 7 });
  assert.deepEqual({ actual: browser.location.hash, accepted: nav.read().hash, reports },
    { actual: '#/working', accepted: '#/working', reports: ['navigation-guard'] });
});

test('a newer failed action inherits responsibility for earlier applied but unpublished history', async (t) => {
  const { browser } = navigationBrowser(t);
  const reports = [];
  const nav = createNavigationCoordinator(browser, { report: (operation) => reports.push(operation) });
  t.after(() => nav.dispose());
  let finish;
  const old = nav.request({ key: 'old', run: async (tx) => {
    tx.navigate('#/working');
    await new Promise((resolve) => { finish = resolve; });
  } });
  const working = browser.location.href;
  const seen = [];
  nav.subscribe((entry) => seen.push(entry.href));
  browser.history.replaceState = () => { throw new Error('private failure'); };
  const newer = nav.request({ key: 'failed', run: (tx) => tx.updateState((state) => ({ ...state, rejected: true })) });
  assert.deepEqual(await newer, { status: 'cancelled' });
  assert.deepEqual({ actual: browser.location.href, accepted: nav.read().href, seen, reports },
    { actual: working, accepted: working, seen: [working], reports: ['navigation-commit'] });
  finish();
  assert.deepEqual(await old, { status: 'cancelled' });
  assert.deepEqual(seen, [working]);
});

test('admission captures a frozen context once and repeated keys retain it', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const checks = [];
  let notice;
  let calls = 0;
  nav.register({ blocked: (context) => { checks.push(context); return true; }, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  const context = { kind: 'sign-out', private: 'not forwarded' };
  const result = nav.request({ key: 'same', context, run: () => { calls += 1; return 7; } });
  context.kind = 'navigation';
  assert.equal(nav.request({ key: 'same', context, run: () => assert.fail('same key retains its original action') }), result);
  assert.deepEqual(notice.context, { kind: 'sign-out' });
  assert.equal(Object.isFrozen(notice.context), true);
  assert.equal(checks[0], notice.context);
  assert.deepEqual(checks, [{ kind: 'sign-out' }]);
  notice.proceed(); notice.proceed(); notice.cancel();
  assert.deepEqual(await result, { status: 'completed', value: 7 });
  assert.equal(calls, 1);
  for (const context of [null, {}, { kind: 'force' }]) {
    assert.throws(() => nav.request({ key: 'invalid', context, run: () => assert.fail() }), { name: 'TypeError', message: 'navigation-context-kind' });
  }
});

test('a retained-style guard admits ordinary and native navigation while guarding sign-out', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  const contexts = [];
  const notices = [];
  nav.register({ blocked: (context) => { contexts.push(context); return context.kind === 'sign-out'; }, onBlocked: (notice) => notices.push(notice), onUnrestorableNavigation() { assert.fail('ordinary navigation is allowed'); } });
  await nav.request({ key: 'normal', run: (tx) => tx.navigate('#/normal') });
  browser.history.back(); await tick();
  assert.deepEqual(contexts, [{ kind: 'navigation' }, { kind: 'navigation' }]);
  assert.equal(notices.length, 0);
  let cleanups = 0;
  const cancelled = nav.request({ key: 'sign-out', context: { kind: 'sign-out' }, run: () => { cleanups += 1; } });
  assert.equal(cleanups, 0);
  notices[0].cancel();
  assert.deepEqual(await cancelled, { status: 'cancelled' });
  const allowed = nav.request({ key: 'sign-out', context: { kind: 'sign-out' }, run: () => { cleanups += 1; } });
  notices[1].proceed(); notices[1].proceed();
  assert.deepEqual(await allowed, { status: 'completed', value: undefined });
  assert.equal(cleanups, 1);
  assert.deepEqual(contexts, [{ kind: 'navigation' }, { kind: 'navigation' }, { kind: 'sign-out' }, { kind: 'sign-out' }]);
});

test('a blocked native history intent exposes the default navigation context', async (t) => {
  const { browser } = navigationBrowser(t);
  const nav = createNavigationCoordinator(browser);
  t.after(() => nav.dispose());
  await nav.request({ key: 'origin', run: (tx) => tx.navigate('#/origin') });
  let notice;
  let context;
  nav.register({ blocked: (value) => { context = value; return true; }, onBlocked: (value) => { notice = value; }, onUnrestorableNavigation() {} });
  browser.history.back(); await tick();
  assert.deepEqual(notice.context, { kind: 'navigation' });
  assert.equal(context, notice.context);
  assert.equal(Object.isFrozen(context), true);
  notice.cancel();
});
