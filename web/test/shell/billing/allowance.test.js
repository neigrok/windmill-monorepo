import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllowance, readAllowance } from '../../../src/shell/billing/allowance.js';

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

const PAID_ALLOWANCE = {
  currency: 'USD',
  period: 'billing_period',
  tier: 'windmill_one',
  configured: true,
  code: 'ok',
  limit: '7.000000000',
  used: '0.075000000',
  reserved: '0.000000000',
  remaining: '6.925000000',
  resetsAtMs: 1798970400000,
  budgetResetsAtMs: null,
  status: 'available',
};

const FREE_ALLOWANCE = {
  currency: 'USD',
  period: 'calendar_month_utc',
  tier: 'logged_in',
  configured: true,
  code: 'ok',
  limit: '0.500000000',
  used: '0.025000000',
  reserved: '0.050000000',
  remaining: '0.425000000',
  resetsAtMs: 1793491200000,
  budgetResetsAtMs: null,
  status: 'available',
};

test('readAllowance validates the backend allowance contract and rejects malformed bodies', () => {
  assert.equal(readAllowance(PAID_ALLOWANCE), PAID_ALLOWANCE);
  assert.equal(readAllowance(FREE_ALLOWANCE), FREE_ALLOWANCE);
  const withoutLimit = { ...FREE_ALLOWANCE, limit: null, resetsAtMs: null };
  assert.equal(readAllowance(withoutLimit), withoutLimit);

  for (const bad of [
    null,
    [],
    'ok',
    { ...PAID_ALLOWANCE, currency: '' },
    { ...PAID_ALLOWANCE, tier: 'enterprise' },
    { ...PAID_ALLOWANCE, period: 'weekly' },
    { ...PAID_ALLOWANCE, configured: 'yes' },
    { ...PAID_ALLOWANCE, remaining: 'NaN' },
    { ...PAID_ALLOWANCE, remaining: 4.5 },
    { ...PAID_ALLOWANCE, limit: 'oops' },
    { ...PAID_ALLOWANCE, resetsAtMs: '1798970400000' },
  ]) {
    assert.equal(readAllowance(bad), null, JSON.stringify(bad));
  }
});

test('fetchAllowance distinguishes ready, disabled (503 ai_allowance_disabled) and error, reporting only unexpected server and shape failures', async () => {
  const cases = [
    [async () => ({ ok: true, status: 200, json: async () => PAID_ALLOWANCE }), { status: 'ready', allowance: PAID_ALLOWANCE }, []],
    [async () => ({ ok: false, status: 503, json: async () => ({ error: 'AI allowances are not enabled.', code: 'ai_allowance_disabled' }) }), { status: 'disabled', allowance: null }, []],
    [async () => ({ ok: false, status: 503, json: async () => ({ error: 'AI allowance is unavailable.', code: 'ai_accounting_unavailable' }) }), { status: 'error', allowance: null }, ['server']],
    [async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('html'); } }), { status: 'error', allowance: null }, ['server']],
    [async () => ({ ok: false, status: 401, json: async () => ({ code: 'unauthenticated' }) }), { status: 'error', allowance: null }, []],
    [async () => ({ ok: true, status: 200, json: async () => ({ ...PAID_ALLOWANCE, configured: false, limit: null }) }), { status: 'error', allowance: null }, []],
    [async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }), { status: 'error', allowance: null }, ['shape']],
    [async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } }), { status: 'error', allowance: null }, ['shape']],
    [async () => { throw new TypeError('Failed to fetch'); }, { status: 'error', allowance: null }, []],
  ];

  for (const [answer, expected, expectedReports] of cases) {
    global.fetch = answer;
    const reports = [];
    const result = await fetchAllowance((reason) => reports.push(reason));
    assert.deepEqual(result, expected);
    assert.deepEqual(reports, expectedReports);
  }
});
