import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadScreen, renderHook, settle } from '../../products/gym/harness.mjs';

const realFetch = global.fetch;
const realWindow = globalThis.window;

const example = (name) => JSON.parse(readFileSync(
  new URL('../../../../packages/api-contract/subscriptions/subscription.json', import.meta.url), 'utf8'))
  .examples.find((entry) => entry.name === name).body;

function fakeWindow(t) {
  t.after(() => {
    global.fetch = realFetch;
    globalThis.window = realWindow;
  });
  const listeners = new Map();
  globalThis.window = {
    location: { hash: '#/settings', pathname: '/app/settings', hostname: 'localhost' },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== fn)),
  };
  return {
    focus: () => (listeners.get('focus') ?? []).forEach((fn) => fn()),
  };
}

test('EntitlementsProvider exposes loading, ready, error, pending retry and window-focus refresh from one /v1/subscription read', async (t) => {
  const win = fakeWindow(t);
  const active = example('active');
  const free = example('never_subscribed_line_closed');
  let calls = 0;
  let nextResponse = async () => ({ ok: true, status: 200, json: async () => active });
  global.fetch = async (url) => {
    assert.equal(url.endsWith('/v1/subscription'), true);
    calls += 1;
    return nextResponse();
  };

  const { default: EntitlementsProvider } = await loadScreen('shell/billing/EntitlementsProvider.jsx');
  const view = renderHook(t, () => EntitlementsProvider({ children: null }), { context: { status: 'signed-in' } });
  const value = () => view.tree.props.value;

  await settle();
  assert.equal(calls, 1);
  assert.equal(value().loading, false);
  assert.equal(value().windmillOne, true);
  assert.equal(value().subscriptionStatus, 'ready');
  assert.equal(value().subscription, active);

  // Window focus re-reads without double-fetching and reflects updated state.
  nextResponse = async () => ({ ok: false, status: 503, json: async () => ({ code: 'subscription_unavailable' }) });
  win.focus();
  await settle();
  assert.equal(calls, 2);
  assert.equal(value().windmillOne, false);
  assert.equal(value().subscriptionStatus, 'error');
  assert.equal(value().subscription, null);

  // Retry with pending: true transitions through loading before settling.
  let resolveRetry;
  nextResponse = () => new Promise((resolve) => { resolveRetry = resolve; });
  const retryPromise = value().refresh({ pending: true });
  assert.equal(value().loading, true);
  assert.equal(value().subscriptionStatus, 'loading');
  resolveRetry({ ok: true, status: 200, json: async () => free });
  const holds = await retryPromise;
  assert.equal(holds, false);
  assert.equal(value().loading, false);
  assert.equal(value().windmillOne, false);
  assert.equal(value().subscriptionStatus, 'ready');
  assert.equal(value().subscription, free);
  view.unmount();
});

test('EntitlementsProvider stays quiet when signed out and exposes no subscription', async (t) => {
  fakeWindow(t);
  let calls = 0;
  global.fetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => example('active') }; };

  const { default: EntitlementsProvider } = await loadScreen('shell/billing/EntitlementsProvider.jsx');
  const view = renderHook(t, () => EntitlementsProvider({ children: null }), { context: { status: 'ghost' } });
  await settle();

  assert.equal(calls, 0);
  assert.equal(view.tree.props.value.loading, false);
  assert.equal(view.tree.props.value.windmillOne, false);
  assert.equal(view.tree.props.value.subscriptionStatus, 'ready');
  assert.equal(view.tree.props.value.subscription, null);
});

test('EntitlementsProvider clears windmillOne and subscription immediately on an account switch while signed in and ignores stale reads', async (t) => {
  fakeWindow(t);
  const active = example('active');
  const free = example('never_subscribed_line_closed');
  const resolvers = [];
  global.fetch = () => new Promise((resolve) => { resolvers.push(resolve); });

  const { default: EntitlementsProvider } = await loadScreen('shell/billing/EntitlementsProvider.jsx');
  const authContext = { status: 'signed-in', user: { id: 'account-A' } };
  const view = renderHook(t, () => EntitlementsProvider({ children: null }), { context: authContext });
  const value = () => view.tree.props.value;

  assert.equal(resolvers.length, 1);
  assert.equal(value().loading, true);
  assert.equal(value().windmillOne, false);

  // Settle account-A as paid Windmill One.
  resolvers[0]({ ok: true, status: 200, json: async () => active });
  await settle();
  assert.equal(value().loading, false);
  assert.equal(value().windmillOne, true);
  assert.equal(value().subscription, active);

  // Start a focus refresh for account-A that stays in flight while the account switches to account-B.
  const staleRefresh = value().refresh();
  assert.equal(resolvers.length, 2);

  // Switch directly from account-A to account-B with status still 'signed-in'.
  authContext.user = { id: 'account-B' };
  view.redraw();

  // Immediately cleared on the transition render — zero leak of account-A's windmillOne or subscription.
  assert.equal(value().loading, true);
  assert.equal(value().windmillOne, false);
  assert.equal(value().subscription, null);
  assert.equal(value().subscriptionStatus, 'loading');
  assert.equal(resolvers.length, 3);

  // Account-A's late response lands after the switch and must be ignored.
  resolvers[1]({ ok: true, status: 200, json: async () => active });
  await staleRefresh;
  await settle();
  assert.equal(value().loading, true);
  assert.equal(value().windmillOne, false);
  assert.equal(value().subscription, null);

  // Account-B's response settles as Free.
  resolvers[2]({ ok: true, status: 200, json: async () => free });
  await settle();
  assert.equal(value().loading, false);
  assert.equal(value().windmillOne, false);
  assert.equal(value().subscriptionStatus, 'ready');
  assert.equal(value().subscription, free);
  view.unmount();
});
