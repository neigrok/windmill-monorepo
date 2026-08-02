import test from 'node:test';
import assert from 'node:assert/strict';

import { beginUpgrade } from '../../../src/shell/billing/checkout.js';

const realFetch = global.fetch;
const realWindow = global.window;

test.afterEach(() => { global.fetch = realFetch; global.window = realWindow; });

// beginUpgrade is the one ceremony behind every door into Windmill One, so what matters is which way it
// falls when the overlay can't open — silently doing nothing would read as a broken button.
test('beginUpgrade — reports failure when no checkout can be minted', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  assert.equal(await beginUpgrade(), false);
});

test('beginUpgrade — falls back to the hosted page when the overlay cannot open', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ transactionId: 'txn_1', checkoutUrl: 'https://pay.example/txn_1' }) });
  const location = { href: '' };
  global.window = { location };  // no Paddle token is configured under test, so the overlay declines
  assert.equal(await beginUpgrade(), true);
  assert.equal(location.href, 'https://pay.example/txn_1');
});

test('beginUpgrade — reports failure when there is no overlay and no hosted page', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ transactionId: 'txn_1' }) });
  global.window = { location: { href: '' } };
  assert.equal(await beginUpgrade(), false);
});
