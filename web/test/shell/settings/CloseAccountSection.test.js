import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';

const realFetch = global.fetch;
const realWindow = globalThis.window;
const realNavigator = globalThis.navigator;

const EXAMPLES = Object.fromEntries(
  JSON.parse(readFileSync(
    new URL('../../../../packages/api-contract/subscriptions/subscription.json', import.meta.url), 'utf8')).examples
    .map(({ name, body }) => [name, body]),
);

function installTelemetryHost(t) {
  t.after(() => {
    global.fetch = realFetch;
    globalThis.window = realWindow;
    globalThis.navigator = realNavigator;
  });
  const events = [];
  const store = new Map();
  let pendingFlush = null;
  globalThis.navigator = { onLine: true };
  globalThis.window = {
    location: { hash: '#/settings', pathname: '/app/settings', hostname: 'windmill.works' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: (fn) => { pendingFlush = fn; return 1; },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/events')) {
      const parsed = JSON.parse(init.body);
      for (const entry of parsed.events) events.push({ name: entry.name, props: entry.props });
    }
    return { ok: true, status: 204 };
  };
  return {
    drain: () => {
      const fn = pendingFlush;
      pendingFlush = null;
      fn?.();
      return events.splice(0, events.length);
    },
  };
}

function expand(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === 'function' && (node.type.name === 'Section' || node.type.name === 'ExternalLink')) {
    return expand(node.type(node.props));
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

function openCloseSection(t, CloseAccountSection, entitlementContext) {
  const context = {
    user: { id: 'u1', email: 'ada@example.com' },
    closeAccount: async () => {},
    ...entitlementContext,
  };
  const view = renderHook(t, () => CloseAccountSection(), { context });
  const collapsed = expand(view.tree);
  assert.equal(elementsOf(collapsed).some((el) => el.type === 'a'), false, 'no store link while collapsed');
  const openBtn = elementsOf(collapsed).find((el) => el.type === 'button');
  openBtn.props.onClick();
  const expanded = expand(view.tree);
  const all = elementsOf(expanded);
  const links = all.filter((el) => el.type === 'a').map((el) => ({
    label: textOf(el),
    href: el.props.href,
    target: el.props.target,
    rel: el.props.rel,
    click: () => el.props.onClick?.(),
  }));
  const firstLinkIdx = all.findIndex((el) => el.type === 'a');
  const dealListIdx = all.findIndex((el) => el.type === 'ul');
  return { links, firstLinkIdx, dealListIdx };
}

test('CloseAccountSection shows Cancel with {store} above the deal list for charging production subscriptions and emits telemetry', async (t) => {
  const telemetry = installTelemetryHost(t);
  const { CloseAccountSection } = await loadScreen('shell/settings/CloseAccountSection.jsx');

  // Production active renewing -> Cancel with Apple above deal list
  {
    const ui = openCloseSection(t, CloseAccountSection, { subscriptionStatus: 'ready', subscription: EXAMPLES.active });
    assert.ok(ui.firstLinkIdx > -1 && ui.firstLinkIdx < ui.dealListIdx);
    assert.deepEqual(ui.links.map((l) => [l.label, l.href, l.target, l.rel]), [
      ['Cancel with Apple', 'https://apps.apple.com/account/subscriptions', '_blank', 'noopener noreferrer'],
    ]);
    ui.links[0].click();
    assert.deepEqual(telemetry.drain(), [
      { name: 'account_close_store_link_shown', props: { store: 'app_store' } },
      { name: 'subscription_manage_opened', props: { store: 'app_store', from: 'close_account', reason: 'manage' } },
    ]);
  }

  // Grace and on_hold also show Cancel with Apple
  for (const name of ['grace', 'on_hold']) {
    const ui = openCloseSection(t, CloseAccountSection, { subscriptionStatus: 'ready', subscription: EXAMPLES[name] });
    assert.deepEqual(ui.links.map((l) => l.label), ['Cancel with Apple'], name);
    assert.deepEqual(telemetry.drain(), [{ name: 'account_close_store_link_shown', props: { store: 'app_store' } }], name);
  }

  // Paying twice across Apple + Google Play shows one link per distinct store
  {
    const crossStore = {
      ...EXAMPLES.charged_twice,
      others: [{ ...EXAMPLES.charged_twice.others[0], store: 'play_store' }],
    };
    const ui = openCloseSection(t, CloseAccountSection, { subscriptionStatus: 'ready', subscription: crossStore });
    assert.deepEqual(ui.links.map((l) => [l.label, l.href]), [
      ['Cancel with Apple', 'https://apps.apple.com/account/subscriptions'],
      ['Cancel with Google Play', 'https://play.google.com/store/account/subscriptions'],
    ]);
    assert.deepEqual(telemetry.drain(), [
      { name: 'account_close_store_link_shown', props: { store: 'app_store' } },
      { name: 'account_close_store_link_shown', props: { store: 'play_store' } },
    ]);
  }

  // Paying twice on the same store deduplicates to one link
  {
    const ui = openCloseSection(t, CloseAccountSection, { subscriptionStatus: 'ready', subscription: EXAMPLES.charged_twice });
    assert.deepEqual(ui.links.map((l) => l.label), ['Cancel with Apple']);
    assert.deepEqual(telemetry.drain(), [{ name: 'account_close_store_link_shown', props: { store: 'app_store' } }]);
  }
});

test('CloseAccountSection hides the store cancel link for sandbox, renewal-off, ended, free, loading and error states', async (t) => {
  const telemetry = installTelemetryHost(t);
  const { CloseAccountSection } = await loadScreen('shell/settings/CloseAccountSection.jsx');

  const hiddenCases = [
    ['sandbox', { subscriptionStatus: 'ready', subscription: EXAMPLES.sandbox_allowlisted }],
    ['renewal_off', { subscriptionStatus: 'ready', subscription: EXAMPLES.cancelled_access_continues }],
    ['expired', { subscriptionStatus: 'ready', subscription: EXAMPLES.expired_line_open }],
    ['revoked', { subscriptionStatus: 'ready', subscription: EXAMPLES.revoked_line_open }],
    ['free', { subscriptionStatus: 'ready', subscription: EXAMPLES.never_subscribed_line_closed }],
    ['error', { subscriptionStatus: 'error', subscription: null }],
    ['loading', { subscriptionStatus: 'loading', subscription: null }],
  ];

  for (const [label, ctx] of hiddenCases) {
    const ui = openCloseSection(t, CloseAccountSection, ctx);
    assert.deepEqual(ui.links, [], label);
    assert.deepEqual(telemetry.drain(), [], label);
  }
});
