import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';

import { elementsOf, loadScreen, renderHook, textOf } from '../../products/gym/harness.mjs';
import { formatMoney, shortDayMonth } from '../../../src/shell/settings/format.js';

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
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}

function inspect(tree) {
  const dom = expand(tree);
  const all = elementsOf(dom);
  const links = all.filter((el) => el.type === 'a').map((el) => ({
    label: textOf(el),
    href: el.props.href,
    target: el.props.target,
    rel: el.props.rel,
    hasArrowIcon: elementsOf(el).some((child) => child.type === 'svg' && child.props.width === '12' && child.props.height === '12'),
    click: () => el.props.onClick?.(),
  }));
  const buttons = all.filter((el) => el.type === 'button').map((el) => ({
    label: textOf(el),
    click: () => el.props.onClick?.(),
  }));
  const tags = all
    .filter((el) => el.type === 'span' && el.props.style?.letterSpacing === '.05em')
    .map((el) => ({ label: textOf(el), style: el.props.style }));
  const text = textOf(dom);
  const dangerStyled = all.some((el) => JSON.stringify(el.props.style ?? {}).includes('danger')
    || JSON.stringify(el.props.style ?? {}).includes('brick'));
  return { dom, all, links, buttons, tags, text, dangerStyled };
}

function assertNoBuyControl(view) {
  for (const word of ['Buy', 'Upgrade', 'Subscribe', 'Start trial', 'Checkout']) {
    assert.equal(view.text.includes(word), false, `unexpected buy copy "${word}" in: ${view.text}`);
  }
}

test('PlanSection covers every state in the approved state matrix, formats from response data only, and emits only bounded labels', async (t) => {
  const telemetry = installTelemetryHost(t);
  const { PlanSection } = await loadScreen('shell/settings/PlanSection.jsx');
  const active = EXAMPLES.active;
  const beforeEnd = active.governing.nextChargeAt - 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: beforeEnd });

  // 1. Checking (loading)
  {
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'loading', subscription: null } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('Plan'), true);
    assert.equal(ui.text.includes('Checking…'), true);
    assert.equal(ui.text.includes('Free'), false);
    assert.deepEqual(telemetry.drain(), []);
  }

  // 2. Error + Retry (P9) — never shows Free
  {
    let retried = null;
    const view = renderHook(t, () => PlanSection(), {
      context: { subscriptionStatus: 'error', subscription: null, refresh: (opts) => { retried = opts; } },
    });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('Plan unavailable'), true);
    assert.equal(ui.text.includes('Free'), false);
    assert.equal(ui.dangerStyled, false);
    assert.deepEqual(ui.buttons.map((b) => b.label), ['Retry']);
    ui.buttons[0].click();
    assert.deepEqual(retried, { pending: true });
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'error', store: 'none', environment: 'none', twice: false } },
      { name: 'plan_retry', props: { section: 'plan' } },
    ]);
  }

  // 3. Free (P1) — never subscribed & owner without governing
  for (const name of ['never_subscribed_line_closed', 'never_subscribed_line_open', 'owner_line_open']) {
    const sub = EXAMPLES[name];
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('Free'), true, name);
    assert.deepEqual(ui.links, [], name);
    assert.deepEqual(ui.buttons, [], name);
    assert.deepEqual(ui.tags, [], name);
    assertNoBuyControl(ui);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'free', store: 'none', environment: 'production', twice: false } },
    ]);
  }

  // 4. Active renewing (P2) — production App Store with Refunds link
  {
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: active } });
    const ui = inspect(view.tree);
    const amount = formatMoney(active.governing.nextCharge.amount, active.governing.nextCharge.currency);
    const nextDate = shortDayMonth(active.governing.nextChargeAt);
    const sinceDate = shortDayMonth(active.governing.startedAt);
    assert.equal(ui.text.includes('Windmill One'), true);
    assert.equal(ui.text.includes(`Next charge ${amount} on ${nextDate}`), true);
    assert.equal(ui.text.includes('Billed by Apple'), true);
    assert.equal(ui.text.includes(`Since ${sinceDate}`), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ACTIVE']);
    assert.equal(ui.tags[0].style.color, 'var(--accent-olive-600)');
    assert.deepEqual(ui.links.map((l) => [l.label, l.href, l.target, l.rel, l.hasArrowIcon]), [
      ['Manage', 'https://apps.apple.com/account/subscriptions', '_blank', 'noopener noreferrer', true],
      ['Refunds', 'https://reportaproblem.apple.com', '_blank', 'noopener noreferrer', true],
    ]);
    assertNoBuyControl(ui);
    assert.equal(ui.dangerStyled, false);
    ui.links[0].click();
    ui.links[1].click();
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'active', store: 'app_store', environment: 'production', twice: false } },
      { name: 'subscription_manage_opened', props: { store: 'app_store', from: 'plan', reason: 'manage' } },
      { name: 'subscription_refund_help_opened', props: { store: 'app_store' } },
    ]);
  }

  // 5. Active renewal slack (nextChargeAt <= now while still active)
  {
    t.mock.timers.setTime(active.governing.nextChargeAt + 60_000);
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: active } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes(`Renewal due ${shortDayMonth(active.governing.nextChargeAt)}`), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ACTIVE']);
    assert.deepEqual(ui.links.map((l) => l.label), ['Manage', 'Refunds']);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'renewal_slack', store: 'app_store', environment: 'production', twice: false } },
    ]);
    t.mock.timers.setTime(beforeEnd);
  }

  // 6. Active renewal off (P3)
  {
    const sub = EXAMPLES.cancelled_access_continues;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes(`Renewal off · ends ${shortDayMonth(sub.governing.currentPeriod.end)}`), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ACTIVE']);
    assert.deepEqual(ui.links.map((l) => l.label), ['Manage', 'Refunds']);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'renewal_off', store: 'app_store', environment: 'production', twice: false } },
    ]);
  }

  // 7. Grace (P4) — ACTIVE tag + Update payment + Refunds, no brick color
  {
    const sub = EXAMPLES.grace;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes(`Payment retrying · until ${shortDayMonth(sub.governing.graceEndsAt)}`), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ACTIVE']);
    assert.deepEqual(ui.links.map((l) => l.label), ['Update payment', 'Refunds']);
    assert.equal(ui.dangerStyled, false);
    ui.links[0].click();
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'grace', store: 'app_store', environment: 'production', twice: false } },
      { name: 'subscription_manage_opened', props: { store: 'app_store', from: 'plan', reason: 'update_payment' } },
    ]);
  }

  // 8. On hold (P5) — neutral ON HOLD tag + Update payment, no Refunds, no brick color
  {
    const sub = EXAMPLES.on_hold;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes(`Payment failed ${shortDayMonth(sub.governing.paymentFailedAt)}`), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ON HOLD']);
    assert.equal(ui.tags[0].style.color, 'var(--text-secondary)');
    assert.deepEqual(ui.links.map((l) => l.label), ['Update payment']);
    assert.equal(ui.dangerStyled, false);
    ui.links[0].click();
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'on_hold', store: 'app_store', environment: 'production', twice: false } },
      { name: 'subscription_manage_opened', props: { store: 'app_store', from: 'plan', reason: 'update_payment' } },
    ]);
  }

  // 9. Paused — neutral PAUSED tag + Google Play Manage link, no Refunds
  {
    const resumesAt = Date.parse('2027-01-14T12:00:00Z');
    const paused = {
      ...EXAMPLES.on_hold,
      governing: {
        ...EXAMPLES.on_hold.governing,
        store: 'play_store',
        state: 'paused',
        paymentFailedAt: null,
        pausedAt: Date.parse('2026-12-14T12:00:00Z'),
        resumesAt,
      },
      manage: { store: 'play_store', url: 'https://play.google.com/store/account/subscriptions' },
    };
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: paused } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes(`Until ${shortDayMonth(resumesAt)}`), true);
    assert.equal(ui.text.includes('Billed by Google Play'), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['PAUSED']);
    assert.deepEqual(ui.links.map((l) => [l.label, l.href]), [
      ['Manage', 'https://play.google.com/store/account/subscriptions'],
    ]);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'paused', store: 'play_store', environment: 'production', twice: false } },
    ]);
  }

  // 10. Expired (P6) — Free row + Windmill One ended row, nothing to manage
  {
    const sub = EXAMPLES.expired_line_open;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('Free'), true);
    assert.equal(ui.text.includes('Windmill One'), true);
    assert.equal(ui.text.includes(shortDayMonth(sub.governing.endedAt)), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ENDED']);
    assert.deepEqual(ui.links, []);
    assertNoBuyControl(ui);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'expired', store: 'app_store', environment: 'production', twice: false } },
    ]);
  }

  // 11. Revoked refunded (P7) vs revoked chargeback
  {
    const sub = EXAMPLES.revoked_line_open;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('Free'), true);
    assert.equal(ui.text.includes(shortDayMonth(sub.governing.endedAt)), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['REFUNDED']);
    assert.deepEqual(ui.links, []);
    assertNoBuyControl(ui);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'revoked', store: 'app_store', environment: 'production', twice: false } },
    ]);

    const chargeback = { ...sub, governing: { ...sub.governing, endReason: 'chargeback' } };
    const view2 = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: chargeback } });
    assert.deepEqual(inspect(view2.tree).tags.map((tag) => tag.label), ['ENDED']);
    telemetry.drain();
  }

  // 12. Paying twice (P8) — both subscriptions listed with store manage URLs + Refunds
  {
    const sub = {
      ...EXAMPLES.charged_twice,
      others: [{ ...EXAMPLES.charged_twice.others[0], store: 'play_store', state: 'grace', nextCharge: null, nextChargeAt: null }],
    };
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.equal(ui.text.includes('2 subscriptions'), true);
    assert.equal(ui.text.includes('Billed by Apple'), true);
    assert.equal(ui.text.includes('Billed by Google Play'), true);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['ACTIVE']);
    assert.deepEqual(ui.links.map((l) => [l.label, l.href]), [
      ['Manage', 'https://apps.apple.com/account/subscriptions'],
      ['Update payment', 'https://play.google.com/store/account/subscriptions'],
      ['Refunds', 'https://reportaproblem.apple.com'],
    ]);
    ui.links[1].click();
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'active', store: 'app_store', environment: 'production', twice: true } },
      { name: 'subscription_manage_opened', props: { store: 'play_store', from: 'plan', reason: 'update_payment' } },
    ]);
  }

  // 13. Sandbox (allowlisted) — SANDBOX neutral tag instead of ACTIVE, NO Refunds link
  {
    const sub = EXAMPLES.sandbox_allowlisted;
    const view = renderHook(t, () => PlanSection(), { context: { subscriptionStatus: 'ready', subscription: sub } });
    const ui = inspect(view.tree);
    assert.deepEqual(ui.tags.map((tag) => tag.label), ['SANDBOX']);
    assert.equal(ui.tags[0].style.color, 'var(--text-secondary)');
    assert.deepEqual(ui.links.map((l) => l.label), ['Manage']);
    assert.deepEqual(telemetry.drain(), [
      { name: 'plan_viewed', props: { state: 'active', store: 'app_store', environment: 'sandbox', twice: false } },
    ]);
  }
});
