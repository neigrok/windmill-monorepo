import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { paidPlansOpen } from '../../src/shell/billing/checkout.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pricing = fs.readFileSync(path.join(WEB, 'public', 'pricing.html'), 'utf8');

// Offering to sell is a LINK whose own label carries a price; prose may state the price freely.
const PRICED_LINK = /<a\b[^>]*>[^<]*\$\s*\d/;

test('the pricing page offers a purchase exactly when one can be opened', () => {
  if (paidPlansOpen()) {
    assert.equal(PRICED_LINK.test(pricing), true,
                 'paid plans are open but pricing.html offers no priced link — the price is stated with no way to act on it');
    return;
  }
  assert.equal(PRICED_LINK.test(pricing), false,
               'paidPlansOpen() is false, so a priced link on pricing.html is a door onto a settings page with nothing to buy');
});

test('the not-open-yet language moves with the till', () => {
  if (paidPlansOpen()) {
    assert.equal(pricing.includes('There is nothing to buy yet.'), false,
                 'paid plans are open but pricing.html still says there is nothing to buy');
    assert.equal(pricing.includes('not open yet'), false,
                 'paid plans are open but pricing.html still wears a not-open-yet chip');
    assert.equal(pricing.includes('nothing on this page can be bought today'), false,
                 'paid plans are open but pricing.html still says nothing here can be bought');
    return;
  }
  assert.equal(pricing.includes('nothing on this page can be bought today'), true);
  assert.equal(pricing.includes('There is nothing to buy yet.'), true);
});

test('the example meter does not send anyone looking for a real one', () => {
  assert.equal(pricing.includes("your own appears once you're signed in"), false);
});
