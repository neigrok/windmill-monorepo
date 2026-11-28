import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS } from '../../scripts/staticEvents.js';

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

// The three ways are the pricing contract's words, and the one that names Windmill One says it is not on sale.
test('the three ways to use Windmill say what the pricing contract says, column by column', () => {
  const start = body.indexOf('<ul class="site-wrap site-rule price-ways"');
  const ways = body.slice(start, body.indexOf('</ul>', start));
  const columns = [...ways.matchAll(/<h2>([^<]*)<\/h2>\s*<p class="price-tier">([^<]*)<\/p>\s*<p class="price-text">([^<]*)<\/p>/g)].map((column) => column.slice(1));
  assert.deepEqual(columns, [
    ['By hand', 'Free', 'Trees, steps, sharing and forking in Roadmap. Writing and search by meaning in Journal. Logging, routines and progress in Gym. A tree, a journal page or a workout needs no account.'],
    ['With your own AI', 'Free here', 'Connect the assistant you already have to Roadmap and Gym. You pay whoever provides it. Windmill charges nothing.'],
    ['With Windmill’s AI', '$0.50 of AI a month on a free account', 'Coach in Gym answers from your log and proposes changes you apply. Echoes in Journal show passages you wrote before, and Windmill pays for those. Windmill One, which is not on sale yet, raises the amount to $7 a month and adds Talk.'],
  ]);
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

// /events.js tells a link by the labels it carries and the area around it; the skip link alone tells nothing. Read in
// document order, an area holds the links up to the next one, which is how this page nests them.
test('every link but the skip link carries the labels of the one event it tells, from the lists /events.js sends', () => {
  assert.ok(pricing.includes('<html lang="en" data-look="instrument" data-page="pricing">'));
  let area = null;
  const links = [...body.matchAll(/<(\w+)\b[^>]*>/g)].flatMap(([tag, name]) => {
    const attribute = (key) => new RegExp(`\\s${key}="([^"]+)"`).exec(tag)?.[1] ?? null;
    area = attribute('data-area') ?? area;
    if (name !== 'a') return [];
    return [[attribute('href'), attribute('data-to') && area, attribute('data-to'), attribute('data-product')]];
  });
  assert.deepEqual(links, [
    ['#content', null, null, null],
    ['/', 'header', 'home', null],
    ['/roadmap', 'header', 'landing', 'roadmap'], ['/gym', 'header', 'landing', 'gym'], ['/journal', 'header', 'landing', 'journal'],
    ['/pricing.html', 'header', 'pricing', null],
    ['/?signin', 'header', 'sign_in', null], ['/app/settings', 'header', 'settings', null], ['/app', 'header', 'app', null],
    ['/connect.html', 'ways', 'connect', null],
    ['/roadmap', 'sitemap', 'landing', 'roadmap'], ['/gym', 'sitemap', 'landing', 'gym'], ['/journal', 'sitemap', 'landing', 'journal'],
    ['/connect.html', 'sitemap', 'connect', null],
    ['/pricing.html', 'sitemap', 'pricing', null], ['/changelog.html', 'sitemap', 'changelog', null],
    ['/gallery', 'sitemap', 'gallery', null], ['/support.html', 'sitemap', 'support', null],
    ['/privacy.html', 'sitemap', 'privacy', null], ['/terms.html', 'sitemap', 'terms', null], ['/refunds.html', 'sitemap', 'refunds', null],
    ['mailto:hello@windmill.works', 'footer', 'feedback', null],
  ]);
  for (const [, area, to, product] of links.slice(1)) {
    assert.ok(LABELS.area.includes(area) && LABELS.to.includes(to) && (product === null || LABELS.product.includes(product)), `${area} ${to} ${product}`);
  }
});

// The footer's sitemap is held to the shared one in test/public/pages.test.mjs; its last row writes to the feedback address.
test('the page has one h1, its header carries the front page\'s links, its footer ends on Feedback, and nothing says About', () => {
  assert.equal(body.match(/<h1\b/g).length, 1);
  const header = body.slice(body.indexOf('<header'), body.indexOf('</header>'));
  assert.deepEqual([...header.matchAll(/href="([^"]+)"/g)].map((link) => link[1]), ['/', '/roadmap', '/gym', '/journal', '/pricing.html', '/?signin', '/app/settings', '/app']);
  const foot = body.slice(body.indexOf('<div class="site-wrap site-foot"'), body.indexOf('</footer>'));
  assert.deepEqual([...foot.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((link) => link.slice(1)), [['mailto:hello@windmill.works', 'Feedback']]);
  assert.equal(/About/.test(text(body)), false);
});
