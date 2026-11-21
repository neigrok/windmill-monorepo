import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pricing = fs.readFileSync(path.join(WEB, 'public', 'pricing.html'), 'utf8');

// Offering to sell is a LINK whose own label carries a price; prose may state the price freely.
const PRICED_LINK = /<a\b[^>]*>[^<]*\$\s*\d/;

// The web holds no checkout, so the page sells nothing and says so.
test('the pricing page offers no purchase and says nothing can be bought', () => {
  assert.equal(PRICED_LINK.test(pricing), false, 'a priced link on pricing.html is a door onto a page with nothing to buy');
  assert.equal(pricing.includes('nothing on this page can be bought today'), true);
  assert.equal(pricing.includes('There is nothing to buy yet.'), true);
});

test('the example meter does not send anyone looking for a real one', () => {
  assert.equal(pricing.includes("your own appears once you're signed in"), false);
});
