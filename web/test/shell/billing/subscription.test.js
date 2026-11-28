import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  fetchSubscription,
  hasProductionAppStoreRefundLink,
  holdsWindmillOne,
  isRenewalSlack,
  manageUrlFor,
  planTelemetry,
  readSubscription,
  storesChargingAfterClose,
  telemetryStore,
} from '../../../src/shell/billing/subscription.js';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const examples = () => JSON.parse(readFileSync(
  new URL('../../../../packages/api-contract/subscriptions/subscription.json', import.meta.url), 'utf8')).examples;

// The device's clock at the epoch, a moment before the active example's access ends, and a year past it: a payer whose
// clock runs ahead keeps Windmill One, and an owner holds it with no plan.
test('every SubscriptionResponse the contract shows is read whole, and holds Windmill One as the server says, whatever the clock', (t) => {
  const active = examples().find(({ name }) => name === 'active').body;
  const clocks = [0, active.accessUntil - 1, active.accessUntil + 365 * 86_400_000];
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const read = clocks.map((now) => {
    t.mock.timers.setTime(now);
    return examples().map(({ name, body }) => {
      assert.equal(readSubscription(body), body, name);
      return [name, holdsWindmillOne(body)];
    });
  });
  assert.deepEqual(read, clocks.map(() => [
    ['active', true],
    ['cancelled_access_continues', true],
    ['grace', true],
    ['on_hold', false],
    ['expired_line_open', false],
    ['revoked_line_open', false],
    ['never_subscribed_line_open', false],
    ['allowlisted_never_subscribed_line_open', false],
    ['never_subscribed_line_closed', false],
    ['owner_line_open', true],
    ['charged_twice', true],
    ['sandbox_allowlisted', true],
    ['sandbox_not_allowlisted_line_open', false],
  ]));
});

test('a body that is not a SubscriptionResponse reads as none, and holds no Windmill One', () => {
  const closed = examples().find(({ name }) => name === 'never_subscribed_line_closed').body;
  const { windmillOne, ...unanswered } = examples().find(({ name }) => name === 'active').body;
  assert.equal(windmillOne, true);
  for (const body of [null, [], 'none', { status: 'none', active: false }, { ...closed, environment: 'staging' },
    { ...closed, purchasable: [1] }, { ...closed, accessUntil: '1799056800000' }, { ...closed, others: undefined },
    { ...closed, others: [null] }, { ...closed, others: ['bad'] }, { ...closed, others: [[]] },
    unanswered, { ...closed, windmillOne: 'true' }]) {
    assert.equal(readSubscription(body), null, JSON.stringify(body));
    assert.equal(holdsWindmillOne(readSubscription(body)), false, JSON.stringify(body));
  }
});

test('the read reports a server failure and a body of another shape, and nothing else', async () => {
  const active = examples().find(({ name }) => name === 'active').body;
  const answers = [
    async () => ({ ok: true, status: 200, json: async () => active }),
    async () => ({ ok: false, status: 401, json: async () => ({ error: 'sign in first' }) }),
    async () => ({ ok: false, status: 503, json: async () => ({ code: 'subscription_unavailable' }) }),
    async () => ({ ok: true, status: 200, json: async () => ({ status: 'none', active: false }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not JSON'); } }),
    async () => { throw new TypeError('Failed to fetch'); },
  ];
  const seen = [];
  for (const answer of answers) {
    global.fetch = answer;
    const reports = [];
    const subscription = await fetchSubscription((reason) => reports.push(reason));
    seen.push([subscription === active ? 'active' : subscription, reports]);
  }
  assert.deepEqual(seen, [
    ['active', []],
    [null, []],
    [null, ['server']],
    [null, ['shape']],
    [null, ['shape']],
    [null, []],
  ]);
});

test('planTelemetry, refund links, renewal slack and close-account cancel stores follow the contract across every fixture', () => {
  const byName = Object.fromEntries(examples().map(({ name, body }) => [name, body]));
  const beforeEnd = byName.active.governing.nextChargeAt - 1000;
  const afterEnd = byName.active.governing.nextChargeAt + 1000;

  assert.equal(isRenewalSlack(byName.active.governing, beforeEnd), false);
  assert.equal(isRenewalSlack(byName.active.governing, afterEnd), true);
  assert.equal(isRenewalSlack(byName.cancelled_access_continues.governing, afterEnd), false);

  assert.deepEqual(planTelemetry('error', null, beforeEnd), { state: 'error', store: 'none', environment: 'none', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.never_subscribed_line_closed, beforeEnd), { state: 'free', store: 'none', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.active, beforeEnd), { state: 'active', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.active, afterEnd), { state: 'renewal_slack', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.cancelled_access_continues, beforeEnd), { state: 'renewal_off', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.grace, beforeEnd), { state: 'grace', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.on_hold, beforeEnd), { state: 'on_hold', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.expired_line_open, beforeEnd), { state: 'expired', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.revoked_line_open, beforeEnd), { state: 'revoked', store: 'app_store', environment: 'production', twice: false });
  assert.deepEqual(planTelemetry('ready', byName.charged_twice, beforeEnd), { state: 'active', store: 'app_store', environment: 'production', twice: true });
  assert.deepEqual(planTelemetry('ready', byName.sandbox_allowlisted, beforeEnd), { state: 'active', store: 'app_store', environment: 'sandbox', twice: false });

  assert.equal(telemetryStore('app_store'), 'app_store');
  assert.equal(telemetryStore('play_store'), 'play_store');
  assert.equal(telemetryStore('paddle'), 'paddle');
  assert.equal(telemetryStore('unknown_vendor'), 'other');
  assert.equal(telemetryStore(null), 'none');

  assert.equal(hasProductionAppStoreRefundLink(byName.active), true);
  assert.equal(hasProductionAppStoreRefundLink(byName.cancelled_access_continues), true);
  assert.equal(hasProductionAppStoreRefundLink(byName.grace), true);
  assert.equal(hasProductionAppStoreRefundLink(byName.charged_twice), true);
  assert.equal(hasProductionAppStoreRefundLink(byName.on_hold), false);
  assert.equal(hasProductionAppStoreRefundLink(byName.expired_line_open), false);
  assert.equal(hasProductionAppStoreRefundLink(byName.revoked_line_open), false);
  assert.equal(hasProductionAppStoreRefundLink(byName.sandbox_allowlisted), false);

  assert.deepEqual(storesChargingAfterClose(byName.active), [{ store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' }]);
  assert.deepEqual(storesChargingAfterClose(byName.grace), [{ store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' }]);
  assert.deepEqual(storesChargingAfterClose(byName.on_hold), [{ store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' }]);
  assert.deepEqual(storesChargingAfterClose(byName.charged_twice), [{ store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' }]);
  assert.deepEqual(storesChargingAfterClose(byName.cancelled_access_continues), []);
  assert.deepEqual(storesChargingAfterClose(byName.expired_line_open), []);
  assert.deepEqual(storesChargingAfterClose(byName.revoked_line_open), []);
  assert.deepEqual(storesChargingAfterClose(byName.sandbox_allowlisted), []);
  assert.deepEqual(storesChargingAfterClose(byName.never_subscribed_line_closed), []);

  const crossStore = {
    ...byName.charged_twice,
    others: [{ ...byName.charged_twice.others[0], store: 'play_store' }],
  };
  assert.deepEqual(storesChargingAfterClose(crossStore), [
    { store: 'app_store', url: 'https://apps.apple.com/account/subscriptions' },
    { store: 'play_store', url: 'https://play.google.com/store/account/subscriptions' },
  ]);
  assert.equal(manageUrlFor(crossStore, crossStore.others[0]), 'https://play.google.com/store/account/subscriptions');

  // Paying twice where App Store entries are on_hold/paused must not show the Apple refund link.
  const twiceOnHold = {
    ...byName.on_hold,
    others: [{ ...byName.on_hold.governing, subscriptionId: 'other-hold', state: 'paused' }],
  };
  assert.equal(hasProductionAppStoreRefundLink(twiceOnHold), false);

  // manageUrlFor ignores Object.prototype keys and malformed https URLs with no host.
  assert.equal(manageUrlFor(byName.active, { store: 'toString' }), null);
  assert.equal(manageUrlFor(byName.active, { store: '__proto__' }), null);
  assert.equal(
    manageUrlFor(
      { ...byName.active, manage: { store: 'paddle', url: 'https://' } },
      { store: 'paddle' },
    ),
    null,
  );
  assert.equal(
    manageUrlFor(
      { ...byName.active, manage: { store: 'paddle', url: 'javascript:alert(1)' } },
      { store: 'paddle' },
    ),
    null,
  );
  assert.equal(
    manageUrlFor(
      { ...byName.active, manage: { store: 'paddle', url: 'https://customer-portal.paddle.com/cpl_123' } },
      { store: 'paddle' },
    ),
    'https://customer-portal.paddle.com/cpl_123',
  );
});
