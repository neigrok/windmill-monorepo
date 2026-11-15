import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fetchSubscription, holdsWindmillOne, readSubscription } from '../../../src/shell/billing/subscription.js';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const examples = () => JSON.parse(readFileSync(
  new URL('../../../../packages/api-contract/subscriptions/subscription.json', import.meta.url), 'utf8')).examples;

test('every SubscriptionResponse the contract shows is read whole, and holds Windmill One until its accessUntil', () => {
  const read = examples().map(({ name, body }) => {
    assert.equal(readSubscription(body), body, name);
    const end = body.accessUntil ?? 1_799_056_800_000;
    return [name, holdsWindmillOne(body, end - 1), holdsWindmillOne(body, end)];
  });
  assert.deepEqual(read, [
    ['active', true, false],
    ['cancelled_access_continues', true, false],
    ['grace', true, false],
    ['on_hold', false, false],
    ['expired_line_open', false, false],
    ['revoked_line_open', false, false],
    ['never_subscribed_line_open', false, false],
    ['allowlisted_never_subscribed_line_open', false, false],
    ['never_subscribed_line_closed', false, false],
    ['owner_line_open', false, false],
    ['charged_twice', true, false],
    ['sandbox_allowlisted', true, false],
    ['sandbox_not_allowlisted_line_open', false, false],
  ]);
});

test('a body that is not a SubscriptionResponse reads as none', () => {
  const closed = examples().find(({ name }) => name === 'never_subscribed_line_closed').body;
  for (const body of [null, [], 'none', { status: 'none', active: false }, { ...closed, environment: 'staging' },
    { ...closed, purchasable: [1] }, { ...closed, accessUntil: '1799056800000' }, { ...closed, others: undefined }]) {
    assert.equal(readSubscription(body), null, JSON.stringify(body));
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
