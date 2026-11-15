import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchSubscription, holdsWindmillOne, readSubscription } from '../../../src/shell/billing/subscription.js';

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
