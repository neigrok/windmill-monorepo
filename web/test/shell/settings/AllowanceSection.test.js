import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { elementsOf, loadScreen, renderHook, settle, textOf } from '../../products/gym/harness.mjs';
import { formatMoney, shortDayMonth } from '../../../src/shell/settings/format.js';

const realFetch = global.fetch;
const realWindow = globalThis.window;
const realNavigator = globalThis.navigator;

function installHost(t, allowanceHandler) {
  t.after(() => {
    global.fetch = realFetch;
    globalThis.window = realWindow;
    globalThis.navigator = realNavigator;
  });
  const events = [];
  const listeners = new Map();
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
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== fn)),
  };
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/events')) {
      const parsed = JSON.parse(init.body);
      for (const entry of parsed.events) events.push({ name: entry.name, props: entry.props });
      return { ok: true, status: 204 };
    }
    assert.equal(String(url).endsWith('/v1/ai/allowance'), true);
    return allowanceHandler();
  };
  return {
    events,
    flush: () => { const fn = pendingFlush; pendingFlush = null; fn?.(); },
    focus: () => (listeners.get('focus') ?? []).forEach((fn) => fn()),
  };
}

function expand(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

test('AllowanceSection hides completely on 503 ai_allowance_disabled', async (t) => {
  installHost(t, async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'AI allowances are not enabled.', code: 'ai_allowance_disabled' }),
  }));
  const { AllowanceSection } = await loadScreen('shell/settings/AllowanceSection.jsx');
  const view = renderHook(t, () => AllowanceSection());
  assert.equal(textOf(expand(view.tree)).includes('Checking…'), true);
  await settle();
  assert.equal(view.tree, null);
  view.unmount();
});

test('AllowanceSection shows unavailable + Retry on error (never $0) and emits plan_retry on retry', async (t) => {
  let attempt = 0;
  const host = installHost(t, async () => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false, status: 503, json: async () => ({ code: 'ai_accounting_unavailable' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        currency: 'USD',
        period: 'billing_period',
        tier: 'windmill_one',
        configured: true,
        code: 'ok',
        limit: '7.000000000',
        used: '2.400000000',
        reserved: '0.000000000',
        remaining: '4.600000000',
        resetsAtMs: 1798970400000,
        budgetResetsAtMs: null,
        status: 'available',
      }),
    };
  });

  const { AllowanceSection } = await loadScreen('shell/settings/AllowanceSection.jsx');
  const view = renderHook(t, () => AllowanceSection());
  await settle();

  const errDom = expand(view.tree);
  const errText = textOf(errDom);
  assert.equal(errText.includes('Allowance unavailable'), true);
  assert.equal(errText.includes('$0'), false);
  const retryBtn = elementsOf(errDom).find((el) => el.type === 'button');
  assert.equal(textOf(retryBtn), 'Retry');

  retryBtn.props.onClick();
  host.flush();
  await settle();
  assert.deepEqual(host.events, [{ name: 'plan_retry', props: { section: 'allowance' } }]);

  const readyDom = expand(view.tree);
  const meter = elementsOf(readyDom).find((el) => el.props?.role === 'meter');
  assert.ok(meter);
  const expectedText = `${formatMoney(4.6, 'USD')} left of ${formatMoney(7, 'USD')}`;
  assert.equal(meter.props['aria-valuenow'], 4.6);
  assert.equal(meter.props['aria-valuemin'], 0);
  assert.equal(meter.props['aria-valuemax'], 7);
  assert.equal(meter.props['aria-valuetext'], expectedText);
  assert.equal(textOf(readyDom).includes(expectedText), true);
  assert.equal(textOf(readyDom).includes(`Until ${shortDayMonth(1798970400000)}`), true);
  const fill = elementsOf(readyDom).find((el) => el.props?.className === 'wm-allowance-fill');
  assert.equal(fill.props.style.width, `${(4.6 / 7) * 100}%`);
  view.unmount();
});

test('AllowanceSection shows Resets date for free calendar month, handles $0 with no danger color, and refreshes on focus', async (t) => {
  let remaining = '0.000000000';
  let calls = 0;
  const host = installHost(t, async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        currency: 'USD',
        period: 'calendar_month_utc',
        tier: 'logged_in',
        configured: true,
        code: remaining === '0.000000000' ? 'subject_exhausted' : 'ok',
        limit: '0.500000000',
        used: '0.500000000',
        reserved: '0.000000000',
        remaining,
        resetsAtMs: 1793491200000,
        budgetResetsAtMs: 1793491200000,
        status: remaining === '0.000000000' ? 'allowance_exhausted' : 'available',
      }),
    };
  });

  const { AllowanceSection } = await loadScreen('shell/settings/AllowanceSection.jsx');
  const view = renderHook(t, () => AllowanceSection());
  await settle();
  assert.equal(calls, 1);

  const zeroDom = expand(view.tree);
  assert.equal(textOf(zeroDom).includes(`${formatMoney(0, 'USD')} left of ${formatMoney(0.5, 'USD')}`), true);
  assert.equal(textOf(zeroDom).includes(`Resets ${shortDayMonth(1793491200000)}`), true);
  const fill = elementsOf(zeroDom).find((el) => el.props?.className === 'wm-allowance-fill');
  assert.equal(fill.props.style.width, '0%');
  const hasDanger = elementsOf(zeroDom).some((el) => JSON.stringify(el.props?.style ?? {}).includes('danger'));
  assert.equal(hasDanger, false);

  remaining = '0.500000000';
  host.focus();
  await settle();
  assert.equal(calls, 2);
  assert.equal(textOf(expand(view.tree)).includes(`${formatMoney(0.5, 'USD')} left of ${formatMoney(0.5, 'USD')}`), true);
  view.unmount();
});
