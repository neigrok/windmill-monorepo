import test from 'node:test';
import assert from 'node:assert/strict';

import { beginUpgrade, pendingTransactionId } from '../../../src/shell/billing/checkout.js';

const realFetch = global.fetch;
const realWindow = global.window;
const realSessionStorage = global.sessionStorage;

function memoryStorage() {
  const cells = new Map();
  return {
    getItem: (key) => (cells.has(key) ? cells.get(key) : null),
    setItem: (key, value) => cells.set(key, String(value)),
    removeItem: (key) => cells.delete(key),
  };
}

test.afterEach(() => { global.fetch = realFetch; global.window = realWindow; global.sessionStorage = realSessionStorage; });

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

// A ?_ptxn on the real origin used to be enough to auto-open a Paddle overlay for whatever
// transaction the link named (audit WEB-3). The parameter is now only ever answered for a
// checkout THIS tab minted, so a link from a stranger resolves to nothing.
test('pendingTransactionId — an id this tab never minted is refused', () => {
  global.sessionStorage = memoryStorage();
  global.window = { location: { search: '?_ptxn=att_ATTACKER_txn' } };
  assert.equal(pendingTransactionId(), '');
});

test('pendingTransactionId — a different id than the one this tab minted is refused', async () => {
  global.sessionStorage = memoryStorage();
  global.fetch = async () => ({ ok: true, json: async () => ({ transactionId: 'txn_mine', checkoutUrl: 'https://pay.example/txn_mine' }) });
  global.window = { location: { href: '', search: '?_ptxn=att_ATTACKER_txn' } };
  await beginUpgrade();
  assert.equal(pendingTransactionId(), '');
});

test('pendingTransactionId — the return trip from this tab\'s own checkout resumes, once', async () => {
  global.sessionStorage = memoryStorage();
  global.fetch = async () => ({ ok: true, json: async () => ({ transactionId: 'txn_mine', checkoutUrl: 'https://pay.example/txn_mine' }) });
  global.window = { location: { href: '', search: '' } };
  await beginUpgrade();

  global.window = { location: { href: '', search: '?_ptxn=txn_mine' } };
  assert.equal(pendingTransactionId(), 'txn_mine');
  assert.equal(pendingTransactionId(), '');  // spent on reading — a replayed link finds nothing
});

// A mint is spent by a return trip, not by a page load. ResumeCheckout runs whenever the account
// settles, and a genuine ?_ptxn can land while the session is still resolving — reading the mint on
// a load that carries no parameter would silently destroy the resume it was minted for.
test('pendingTransactionId — a page load with no ?_ptxn leaves the mint alone', async () => {
  global.sessionStorage = memoryStorage();
  global.fetch = async () => ({ ok: true, json: async () => ({ transactionId: 'txn_mine', checkoutUrl: 'https://pay.example/txn_mine' }) });
  global.window = { location: { href: '', search: '' } };
  await beginUpgrade();

  assert.equal(pendingTransactionId(), '');
  global.window = { location: { href: '', search: '?_ptxn=txn_mine' } };
  assert.equal(pendingTransactionId(), 'txn_mine');
});
