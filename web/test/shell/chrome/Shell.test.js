import test from 'node:test';
import assert from 'node:assert/strict';
import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

function browser() {
  const listeners = new Map();
  const query = { matches: false, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => query, addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    documentElement: { setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type) => listeners.delete(type),
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  return (type, event) => listeners.get(type)?.(event);
}

const context = { user: { name: 'Ada' }, status: 'signed-in', signOut() {}, open() {}, lendHost() {} };
const location = { pathname: '/app', hash: '', search: '' };

test('the unpublished Shell header contains only its unchanged mark, navigation and seat', async (t) => {
  browser();
  const { Shell } = await loadScreen('shell/chrome/Shell.jsx');
  const view = renderHook(t, () => Shell({ location }), { context });
  const header = elementsOf(view.tree).find((element) => element.type === 'header');
  assert.equal(header.props.className, 'wm-head');
  assert.deepEqual(header.props.children.filter(Boolean).map((element) => [element.type, element.props.className]), [
    ['a', 'wm-head-mark'], ['nav', 'wm-switch'], ['div', 'wm-head-seat'],
  ]);
});

test('the slot has one full polite announcement and a named narrow tap with the offline icon', async (t) => {
  browser();
  const { publishRoomStatus } = await loadScreen('shell/roomStatus.js');
  const release = publishRoomStatus({ line: 'Offline · changes will sync', short: 'Offline', icon: 'offline', narrow: 'icon' });
  t.after(release);
  const { Shell } = await loadScreen('shell/chrome/Shell.jsx');
  const view = renderHook(t, () => Shell({ location }), { context });
  const slot = elementsOf(view.tree).find((element) => element.type?.name === 'RoomStatus');
  const rendered = renderHook(t, () => slot.type(slot.props));
  const announcement = elementsOf(rendered.tree).filter((element) => element.props.role === 'status');
  assert.deepEqual(announcement.map((element) => ({
    live: element.props['aria-live'], atomic: element.props['aria-atomic'], name: element.props['aria-label'], text: textOf(element),
  })), [{ live: 'polite', atomic: 'true', name: 'Offline · changes will sync', text: 'Offline · changes will sync' }]);
  assert.deepEqual(elementsOf(rendered.tree).filter((element) => element.type === 'button').map((element) => ({
    name: element.props['aria-label'], type: element.props.type,
  })), [{ name: 'Offline · changes will sync', type: 'button' }]);
});

test('tooltip timing, second press, outside press and changed line dismiss the transient detail', async (t) => {
  const fire = browser();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { publishRoomStatus } = await loadScreen('shell/roomStatus.js');
  const release = publishRoomStatus({ line: 'Offline · changes will sync', short: 'Offline', icon: 'offline', narrow: 'icon' });
  t.after(release);
  const { Shell } = await loadScreen('shell/chrome/Shell.jsx');
  const host = renderHook(t, () => Shell({ location }), { context });
  const slot = elementsOf(host.tree).find((element) => element.type?.name === 'RoomStatus');
  const props = { ...slot.props };
  const view = renderHook(t, () => slot.type(props));
  const tap = () => elementsOf(view.tree).find((element) => element.type === 'button').props.onClick();
  const tip = () => elementsOf(view.tree).filter((element) => element.props.role === 'tooltip').map(textOf);
  tap();
  assert.deepEqual(tip(), ['Offline · changes will sync']);
  t.mock.timers.tick(3999);
  assert.deepEqual(tip(), ['Offline · changes will sync']);
  t.mock.timers.tick(1);
  assert.deepEqual(tip(), []);
  tap();
  tap();
  assert.deepEqual(tip(), []);
  tap();
  fire('pointerdown', { target: {} });
  assert.deepEqual(tip(), []);
  tap();
  props.status = { line: 'Saved', narrow: 'announce' };
  view.redraw();
  assert.deepEqual(tip(), []);
  props.status = slot.props.status;
  view.redraw();
  assert.deepEqual(tip(), []);
});

test('the published device line places a direct sign-in door beside the line', async (t) => {
  browser();
  const { publishRoomStatus } = await loadScreen('shell/roomStatus.js');
  const release = publishRoomStatus({ line: 'Saved on this device — sign in to keep it' });
  t.after(release);
  let opened = 0;
  const { Shell } = await loadScreen('shell/chrome/Shell.jsx');
  const view = renderHook(t, () => Shell({ location }), { context: { ...context, status: 'ghost', user: null, open: () => { opened += 1; } } });
  const seat = elementsOf(view.tree).find((element) => element.props.className === 'wm-head-seat');
  assert.equal(seat.props.children.type, 'button');
  assert.equal(textOf(seat), 'Sign in');
  seat.props.children.props.onClick();
  assert.equal(opened, 1);
});
