// The price and the door have to agree. /pricing.html is a hand-written static page and
// billing/checkout.js is the running app, and nothing connected them: the page shipped a primary CTA
// reading "Get Windmill One — $12/month" pointed at /#/settings, while paidPlansOpen() was false, so
// the settings page never mounted a Plan section and the visitor landed on a page with nothing to buy
// and no word about why. A price with a door onto nothing is the manufactured urgency the mission
// section forbids, and it survived because the two halves are in different languages.
//
// This is the wire between them, in both directions — the failure it exists to catch is somebody
// flipping one and not the other, in either order.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { paidPlansOpen } from '../../src/shell/billing/checkout.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pricing = fs.readFileSync(path.join(WEB, 'public', 'pricing.html'), 'utf8');

// What counts as offering to sell: a LINK whose own label carries a price. The header's "Start your
// tree" is a primary button too and is not one of these — it opens the free product, which is exactly
// what this page says is free. The prose may say $12 as often as it likes; only a door may not.
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

// Pulling the button is only half of honest. The page keeps the price on purpose — a person deciding
// whether to build years of work on Windmill deserves the number up front — so it has to say, in
// words and not by omission, that the number is not yet chargeable.
test('while nothing is for sale, the page says so plainly', () => {
  if (paidPlansOpen()) return;
  assert.equal(pricing.includes('nothing on this page can be bought today'), true);
  assert.equal(pricing.includes('There is nothing to buy yet.'), true);
});

// The one instruction on the page that a reader could follow and find nothing at the end of. It read
// "your own appears once you're signed in" — of a tending meter that does not exist while
// TENDING_ENABLED defaults false.
test('the example meter does not send anyone looking for a real one', () => {
  assert.equal(pricing.includes("your own appears once you're signed in"), false);
});
