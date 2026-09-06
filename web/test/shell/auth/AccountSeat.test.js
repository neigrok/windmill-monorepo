// The seat's pop-up, opened and rendered to the leaf: the Appearance radiogroup is there for a
// visitor and a member alike, the rows below it are the one menu, and Escape hands focus back.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

function browser() {
  const listeners = new Map();
  const query = { matches: false, addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => query, addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  return { fire: (type, event) => listeners.get(type)?.(event), listening: () => [...listeners.keys()].sort() };
}

// Every function component under `node`, rendered in turn, so the tree reads down to the elements.
function expand(t, node) {
  if (Array.isArray(node)) return node.map((each) => expand(t, each));
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === 'function') return expand(t, renderHook(t, () => node.type(node.props)).tree);
  const { children, ...rest } = node.props;
  if (children === undefined) return node;
  return React.cloneElement(node, rest, ...(Array.isArray(children) ? children.map((each) => expand(t, each)) : [expand(t, children)]));
}

async function openSeat(t, props) {
  const { AccountSeat } = await loadScreen('shell/auth/AccountSeat.jsx');
  const view = renderHook(t, () => AccountSeat(props));
  const seat = () => elementsOf(view.tree).find((each) => each.type === 'button' && 'aria-expanded' in each.props);
  assert.equal(seat().props['aria-expanded'], false);
  assert.equal(seat().props['aria-haspopup'], undefined, 'the pop-up is not a menu, so the seat must not promise one');
  seat().props.onClick();
  assert.equal(seat().props['aria-expanded'], true);
  const tree = expand(t, view.tree);
  const popover = elementsOf(tree).find((each) => each.props.id === seat().props['aria-controls']);
  assert.ok(popover, 'the seat names the pop-up it controls');
  return { view, seat, tree, popover };
}

function shape(popover) {
  const inside = elementsOf(popover.props.children);
  const group = inside.find((each) => each.props.role === 'radiogroup');
  const label = inside.find((each) => each.props.id === group?.props['aria-labelledby']);
  const menus = inside.filter((each) => each.props.role === 'menu');
  return {
    popoverRole: popover.props.role ?? null,
    width: popover.props.style.width,
    label: label ? textOf(label) : null,
    radios: inside.filter((each) => each.props.role === 'radio').map((each) => [textOf(each), each.props['aria-checked']]),
    menus: menus.map((menu) => elementsOf(menu.props.children).filter((each) => each.props.role === 'menuitem').map(textOf)),
    order: inside.filter((each) => ['radiogroup', 'menu'].includes(each.props.role)).map((each) => each.props.role),
  };
}

test('signed out, the pop-up is a popover: the Appearance radiogroup, then the one menu', async (t) => {
  browser();
  const { popover } = await openSeat(t, { status: 'ghost', user: null, onSignIn() {}, onSettings() {} });
  assert.deepEqual(shape(popover), {
    popoverRole: null,
    width: 'min(272px, calc(100vw - 24px))',
    label: 'Appearance',
    radios: [['Light', false], ['Dark', false], ['System', true]],
    menus: [['Sign in', 'Settings']],
    order: ['radiogroup', 'menu'],
  });
});

test('signed in, the same radiogroup sits between the identity and the menu', async (t) => {
  browser();
  const user = { name: 'Ada Lovelace', email: 'ada@example.com' };
  const { popover } = await openSeat(t, { status: 'signed-in', user, onConnect() {}, onSettings() {}, onSignOut() {} });
  assert.deepEqual(shape(popover), {
    popoverRole: null,
    width: 'min(272px, calc(100vw - 24px))',
    label: 'Appearance',
    radios: [['Light', false], ['Dark', false], ['System', true]],
    menus: [['Connect your LLM tools', 'Account settings', 'Sign out']],
    order: ['radiogroup', 'menu'],
  });
  const identity = elementsOf(popover.props.children).map(textOf).join(' ');
  assert.ok(identity.includes('Ada Lovelace') && identity.includes('ada@example.com'));
  assert.ok(elementsOf(popover.props.children).findIndex((each) => textOf(each) === 'Ada Lovelace')
    < elementsOf(popover.props.children).findIndex((each) => each.props.role === 'radiogroup'), 'identity first');
});

test('Escape and a press outside both close the pop-up and hand focus back to the seat', async (t) => {
  for (const [type, event] of [['keydown', { key: 'Escape' }], ['pointerdown', { target: {} }]]) {
    const dom = browser();
    const { view, seat } = await openSeat(t, { status: 'ghost', user: null, onSignIn() {}, onSettings() {} });
    assert.deepEqual(dom.listening(), ['keydown', 'pointerdown']);
    let focused = 0;
    seat().ref.current = { focus: () => { focused += 1; } };
    dom.fire(type, event);
    assert.equal(seat().props['aria-expanded'], false, `${type} did not close the pop-up`);
    assert.equal(focused, 1, `${type} did not return focus to the seat`);
    assert.deepEqual(dom.listening(), [], 'the closed pop-up still listens to the document');
    view.unmount();
  }
});
