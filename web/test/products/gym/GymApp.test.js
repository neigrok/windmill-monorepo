import test from 'node:test';
import assert from 'node:assert/strict';
import { navigate, initializeNavigation, previousLocation, returnToPreviousLocation } from '../../../src/shell/navigation.js';
import { navigationBrowser } from '../../shell/navigationBrowser.mjs';
import { syncSession } from '../../../src/platform/sync/session.js';
import { browserWith, elementsOf, gymAccount, loadScreen, renderHook } from './harness.mjs';

test('bookmarked gym connection doors replace themselves with shared setup without a Back loop', async (t) => {
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  const oldWindow = globalThis.window;
  const oldPopStateEvent = globalThis.PopStateEvent;
  t.after(() => { globalThis.window = oldWindow; globalThis.PopStateEvent = oldPopStateEvent; });
  globalThis.PopStateEvent = class { constructor(type) { this.type = type; } };
  for (const status of ['ghost', 'signed-in']) {
    for (const hash of ['#/gym/connect', '#/gym/connect/', '#/gym/connect?from=routines']) {
      for (const direct of [true, false]) {
        const { browser, entries } = navigationBrowser(t, {
          href: direct ? `/app/gym${hash}` : '/app/gym?week=2#/gym/ask', install: false,
        });
        globalThis.window = browser;
        initializeNavigation();
        if (!direct) navigate(`/app/gym${hash}`);
        const view = renderHook(t, () => GymApp({ hash, inShell: true }), {
          context: { status, user: status === 'signed-in' ? { id: 'member' } : null, open() {}, lendHost() {} },
        });
        assert.equal(view.tree, null, 'the retired page mounts neither a pitch nor an authenticated log');
        assert.equal(browser.location.href, 'https://windmill.works/app/connect');
        assert.equal(entries.length, direct ? 1 : 2, 'redirect replaces the legacy entry');
        await returnToPreviousLocation();
        assert.equal(browser.location.href, direct ? 'https://windmill.works/app' : 'https://windmill.works/app/gym?week=2#/gym/ask');
        assert.equal(previousLocation(), null);
        assert.equal(entries.length, direct ? 1 : 2);
        view.unmount();
      }
    }
  }
});

test('the room draws the replica this tab holds whether or not the account has answered, the browser’s own copy signed out, as long as its binding stands', async (t) => {
  browserWith();
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  let session = null;
  t.mock.method(syncSession, 'getSnapshot', () => session);
  // `account` is the one the shell has settled, as it tells the session.
  const doorOf = (snapshot, status, account = null) => {
    const engine = { getSnapshot: () => snapshot, observeEngine: () => () => {} };
    session = { engine: snapshot ? engine : null, ready: snapshot !== null, signedIn: status === 'signed-in' || null, account, online: true, error: false };
    const user = account ? { id: account } : null;
    const view = renderHook(t, () => GymApp({ hash: '#/gym', inShell: true }), {
      context: { status, user, account: user, open() {}, lendHost() {} },
    });
    const drawn = elementsOf(view.tree);
    view.unmount();
    const room = drawn.find((each) => each.type?.name === 'TrainingRoom');
    if (room) return `room ${room.key}`;
    return drawn.some((each) => each.type?.name === 'Opening') ? 'opening' : 'nothing';
  };
  const bound = (account, replica = 'rp_wire1') => ({ replica, state: 'bound', account, binding: `["rp_handle","${account}"]` });
  const anon = { replica: 'rp_anon', state: 'anon', account: null, binding: '["rp_anon",null]' };
  assert.deepEqual([
    doorOf(null, 'loading'), doorOf(bound('A'), 'loading'), doorOf(bound('A'), 'ghost'), doorOf(bound('A'), 'signed-in', 'A'),
    doorOf(bound('A', 'rp_wire2'), 'signed-in', 'A'), doorOf(bound('B'), 'signed-in', 'A'),
    doorOf(anon, 'loading'), doorOf(anon, 'ghost'), doorOf(anon, 'signed-in', 'A'),
  ], [
    'opening', 'room ["rp_handle","A"]', 'room ["rp_handle","A"]', 'room ["rp_handle","A"]',
    'room ["rp_handle","A"]', 'opening',
    'room ["rp_anon",null]', 'room ["rp_anon",null]', 'opening',
  ]);
});

test('Coach, Notes and the log’s shares wait for an account the shell has settled while the room draws from the copy', async (t) => {
  browserWith();
  await gymAccount(t);
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  const roomOf = (status, hash) => {
    const context = { status, user: status === 'signed-in' ? { id: 'A' } : null, account: status === 'signed-in' ? { id: 'A' } : null,
      open() {}, lendHost() {} };
    const app = renderHook(t, () => GymApp({ hash, inShell: true }), { context });
    const room = elementsOf(app.tree).find((each) => each.type?.name === 'TrainingRoom');
    const view = renderHook(t, () => room.type(room.props), { context });
    const main = elementsOf(view.tree).find((each) => each.type === 'main');
    const screens = elementsOf(main.props.children).filter((each) => typeof each.type === 'function');
    view.unmount();
    app.unmount();
    return screens.map((each) => (each.type.name === 'LogList' ? `LogList signedIn=${each.props.signedIn}` : each.type.name));
  };
  const hashes = ['#/gym/coach', '#/gym/coach/threads', '#/gym/coach/threads/thread0001', '#/gym/notes', '#/gym/share-log', '#/gym/log'];
  assert.deepEqual(hashes.map((hash) => roomOf('loading', hash)),
    [['Opening'], ['Opening'], ['Opening'], ['Opening'], ['Opening'], ['LogList signedIn=false']]);
  assert.deepEqual(hashes.map((hash) => roomOf('ghost', hash)),
    [['CoachDoor'], ['CoachDoor'], ['CoachDoor'], ['CoachDoor'], ['LogList signedIn=false'], ['LogList signedIn=false']]);
  assert.deepEqual(hashes.map((hash) => roomOf('signed-in', hash)),
    [['CoachRoom'], ['HistoryPage'], ['CoachRoom'], ['Notes'], ['LogShareScreen'], ['LogList signedIn=true']]);
});
