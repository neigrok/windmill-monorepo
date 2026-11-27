import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pricing = fs.readFileSync(path.join(WEB, 'public', 'pricing.html'), 'utf8');
const body = pricing.slice(pricing.indexOf('<body>'));
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');

// Windmill One cannot be bought anywhere: the page holds no form, no button and no link whose label carries a price,
// and says so beside the price.
test('the pricing page offers no purchase and says Windmill One is not on sale beside its price', () => {
  assert.equal(/<(form|button|input)\b/.test(body), false, 'a control on pricing.html is a door onto nothing to buy');
  assert.equal(/<a\b[^>]*>[^<]*\$\s*\d/.test(body), false, 'a priced link on pricing.html is a door onto nothing to buy');
  assert.ok(body.includes('<p class="price-row"><span class="price-amount">$12 a month</span> <span class="price-status">Not on sale yet.</span></p>'));
});

// Every number the page states was read off production's settings for the pricing contract; the page adds none.
test('the page states exactly the amounts the pricing contract names', () => {
  const amounts = [...new Set(text(body).match(/\$\d+(\.\d+)?/g))].sort();
  assert.deepEqual(amounts, ['$0.25', '$0.50', '$1.80', '$12', '$3.20', '$7', '$7.00']);
});

// The bar is drawn from the same numbers its labels state, so it cannot show a split the words do not.
test('the bar divides the $12 in the proportion its labels state: 7.00 : 1.80 : 3.20', () => {
  const split = /--price-split: ([^;]+);/.exec(pricing)[1];
  const parts = [...body.matchAll(/<span class="price-part-amount">(?:about )?\$([\d.]+)<\/span>/g)].map((part) => part[1]);
  assert.deepEqual(parts, ['7.00', '1.80', '3.20']);
  assert.equal(split, parts.map((amount) => `${Number(amount)}fr`).join(' '));
  assert.equal(parts.reduce((sum, amount) => sum + Number(amount), 0), 12);
  assert.deepEqual([...body.matchAll(/<span class="(price-[a-z]+)"><\/span>/g)].map((part) => part[1]), ['price-ai', 'price-fees', 'price-windmill']);
});

// The questions a reader sees are the page's structured data, word for word; nothing on it is structured as an offer.
test('the visible questions and the FAQ data are one list, and the page carries no other structured data', () => {
  const scripts = [...pricing.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const data = JSON.parse(scripts[0][1]);
  assert.deepEqual(Object.keys(data).sort(), ['@context', '@id', '@type', 'inLanguage', 'mainEntity', 'url']);
  assert.equal(data['@type'], 'FAQPage');
  const shown = [...body.matchAll(/<div><dt>([^<]*)<\/dt><dd>([^<]*)<\/dd><\/div>/g)].map(([, question, answer]) => [question, answer]);
  assert.equal(shown.length, 8);
  assert.deepEqual(data.mainEntity, shown.map(([name, answer]) => ({ '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text: answer } })));
});

test('the page has one h1, and its header and footer carry the front page\'s links and no About', () => {
  assert.equal(body.match(/<h1\b/g).length, 1);
  const header = body.slice(body.indexOf('<header'), body.indexOf('</header>'));
  assert.deepEqual([...header.matchAll(/href="([^"]+)"/g)].map((link) => link[1]), ['/', '/roadmap', '/gym', '/journal', '/pricing.html', '/?signin', '/app/settings', '/app']);
  const footer = body.slice(body.indexOf('<footer>'), body.indexOf('</footer>'));
  assert.deepEqual([...footer.matchAll(/href="([^"]+)"/g)].map((link) => link[1]), [
    '/roadmap', '/gym', '/journal', '/connect.html', '/pricing.html', '/changelog.html', '/gallery',
    '/privacy.html', '/terms.html', '/refunds.html', 'mailto:hello@windmill.works',
  ]);
  assert.equal(/About/.test(text(body)), false);
});
