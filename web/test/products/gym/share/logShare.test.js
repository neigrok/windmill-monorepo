import test from 'node:test';
import assert from 'node:assert/strict';
import { logShareRequest, publicLogHref, shareHistoryScope } from '../../../../src/products/gym/share/logShare.js';
import { spellWeightsIn, weightUnit } from '../../../../src/products/gym/units.js';
import { logShareApi } from '../../../../src/products/gym/share/logShareApi.js';

test('all history omits dates and a local inclusive date range becomes exclusive next midnight', () => {
  assert.deepEqual(logShareRequest({ mode: 'snapshot', scope: 'all', from: '2024-01-01', until: '2024-01-31' }, 'link'), { value: { id: 'link', mode: 'snapshot', scope: 'all' } });
  assert.deepEqual(logShareRequest({ mode: 'live', scope: 'range', from: '2024-02-28', until: '2024-02-29' }, 'link'), {
    value: { id: 'link', mode: 'live', scope: 'range', from: new Date(2024, 1, 28).getTime(), until: new Date(2024, 2, 1).getTime() },
  });
  for (const [from, until] of [['2024-02-31', '2024-03-02'], ['2024-03-01', '2024-02-01'], ['', '2024-02-01']]) {
    assert.equal('error' in logShareRequest({ mode: 'snapshot', scope: 'range', from, until }, 'link'), true);
  }
});

test('preview filters narrow the chosen scope, and public navigation retains every filter', () => {
  assert.deepEqual(shareHistoryScope({ from: 100, until: 500 }, { from: 50, until: 400, exercise: 'bench', before: 350, beforeId: 's3' }), { from: 100, until: 400, exercise: 'bench', before: 350, beforeId: 's3' });
  assert.equal(publicLogHref('safe token', { year: 2024, month: 2, exercise: 'bench', routine: 'push', density: 'compact', selected: 's3' }), '#/gym/shared-log/safe%20token?year=2024&month=02&exercise=bench&routine=push&density=compact&session=s3');
});

test('preview is an owner read without link mutation; recipient reads omit credentials and request complete progress', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ path: new URL(url).pathname + new URL(url).search, ...options });
    return { ok: true, status: 200, json: async () => ({ sessions: [] }) };
  });
  await logShareApi.preview({ from: 100, until: 500 });
  await logShareApi.read('token', { limit: 50 });
  assert.deepEqual(requests, [
    { path: '/v1/gym/history?from=100&until=500&projection=progress', credentials: 'include', headers: { 'content-type': 'application/json' } },
    { path: '/v1/gym/shared-logs/token?limit=50&projection=progress', credentials: 'omit', headers: { 'content-type': 'application/json' } },
  ]);
});

test('public equal set facts collapse as kg independently of owner pounds and without private set kinds', async (t) => {
  const originalUnit = weightUnit();
  spellWeightsIn('lb');
  t.after(() => spellWeightsIn(originalUnit));
  const { sharedSetScheme } = await import('../../../../src/products/gym/share/logShare.js');
  assert.equal(sharedSetScheme([{ weightKg: 60, reps: 8 }, { weightKg: 60, reps: 8 }]), '2 × 8 · 60');
  assert.equal(sharedSetScheme([{ weightKg: 60, reps: 8, rpe: 7 }, { weightKg: 60, reps: 8, rpe: 8 }]), null);
  assert.equal(sharedSetScheme([{ weightKg: 60, reps: 8 }, { weightKg: 62.5, reps: 8 }]), null);
});
