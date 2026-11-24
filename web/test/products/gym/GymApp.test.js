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

test('the room draws from the replica the engine holds, whether or not the account has answered', async (t) => {
  browserWith();
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  let session = null;
  t.mock.method(syncSession, 'getSnapshot', () => session);
  const doorOf = (snapshot, status) => {
    const engine = { getSnapshot: () => snapshot, observeEngine: () => () => {} };
    session = { engine: snapshot ? engine : null, ready: snapshot !== null, signedIn: status === 'signed-in' || null, online: true, error: false };
    const view = renderHook(t, () => GymApp({ hash: '#/gym', inShell: true }), {
      context: { status, user: status === 'signed-in' ? { id: 'member' } : null, open() {}, lendHost() {} },
    });
    const drawn = elementsOf(view.tree);
    view.unmount();
    const room = drawn.find((each) => each.type?.name === 'TrainingRoom');
    if (room) return `room ${room.key}`;
    if (drawn.some((each) => each.type?.name === 'SignInPitch')) return 'pitch';
    return drawn.some((each) => each.props.className === 'gym-quiet' && each.props.children === 'Opening the log…') ? 'opening' : 'nothing';
  };
  const bound = { replica: 'rp_bound', state: 'bound' };
  const anon = { replica: 'rp_anon', state: 'anon' };
  assert.deepEqual([
    doorOf(null, 'loading'), doorOf(bound, 'loading'), doorOf(bound, 'ghost'), doorOf(bound, 'signed-in'), doorOf(anon, 'loading'), doorOf(anon, 'ghost'),
  ], ['opening', 'room rp_bound', 'room rp_bound', 'room rp_bound', 'opening', 'pitch']);
});

test('Coach and the log’s shares wait for a confirmed account while the room draws from the copy', async (t) => {
  browserWith();
  await gymAccount(t);
  const { GymApp } = await loadScreen('products/gym/GymApp.jsx');
  const roomOf = (status, hash) => {
    const context = { status, user: status === 'signed-in' ? { id: 'member' } : null, account: status === 'signed-in' ? { id: 'member' } : null,
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
  assert.deepEqual(['#/gym/coach', '#/gym/coach/threads', '#/gym/share-log', '#/gym/log'].map((hash) => roomOf('loading', hash)),
    [[], [], [], ['LogList signedIn=false']]);
  assert.deepEqual(['#/gym/coach', '#/gym/coach/threads', '#/gym/share-log', '#/gym/log'].map((hash) => roomOf('signed-in', hash)),
    [['CoachRoom'], ['HistoryPage'], ['LogShareScreen'], ['LogList signedIn=true']]);
});
