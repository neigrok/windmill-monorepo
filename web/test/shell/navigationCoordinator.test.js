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
