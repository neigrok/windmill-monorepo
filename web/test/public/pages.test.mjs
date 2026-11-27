import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScreen } from '../products/gym/harness.mjs';

const PAGES = new URL('../../public/', import.meta.url);
const pages = fs.readdirSync(PAGES).filter((name) => name.endsWith('.html')).sort();
const read = (name) => fs.readFileSync(new URL(name, PAGES), 'utf8');
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');

// What the owner ruled for every page a visitor can read: one price, on the pricing page; no payment company, no
// refund promise; and an AI that guides rather than does the work.
test('no page but pricing states a price', () => {
  const priced = pages.filter((name) => name !== 'pricing.html' && /\$\s?\d/.test(text(read(name)) + (/<meta name="description" content="([^"]*)"/.exec(read(name))?.[1] ?? '')));
  assert.deepEqual(priced, []);
});

test('no page names a payment company or promises a refund, and none says the AI does the work', () => {
  const refused = ['Paddle', 'seller of record', 'money-back', '30-day', 'Apple’s fee', "Apple's fee", 'works for you', 'does it for you', 'never use your AI allowance'];
  const said = pages.flatMap((name) => refused.filter((phrase) => read(name).toLowerCase().includes(phrase.toLowerCase())).map((phrase) => `${name}: ${phrase}`));
  assert.deepEqual(said, []);
});

// The support page is one address a person, and a store listing, can always reach: every page in the family look links
// it from its footer row, and the 404 lists it.
test('every family page links Support from its footer row, and the 404 lists it', () => {
  const family = pages.filter((name) => name !== 'pricing-preview.html' && !/<html\b[^>]*\sdata-look=/.test(read(name)));
  assert.deepEqual(family, ['404.html', 'changelog.html', 'connect.html', 'gallery.html', 'pause.html', 'privacy.html', 'refunds.html', 'support.html', 'terms.html']);
  for (const name of family) {
    assert.ok(read(name).includes('<a href="/refunds.html">Refunds</a><a href="/changelog.html">Changelog</a><a href="/support.html">Support</a></span>'), name);
  }
  assert.ok(read('404.html').includes('<a href="/refunds.html">Refunds</a> · <a href="/support.html">Support</a></li>'));
});

// A page in the instrument look writes the site's footer by hand; it is the one the front page and the landings draw
// (SiteChrome.jsx), column by column and link by link, so the two cannot drift.
test('every instrument page\'s footer has the shared footer\'s columns and links, in its order', async () => {
  const { SITEMAP } = await loadScreen('shell/marketing/SiteChrome.jsx');
  const instrument = pages.filter((name) => /<html\b[^>]*\sdata-look="instrument"/.test(read(name)));
  assert.deepEqual(instrument, ['pricing.html']);
  const shared = SITEMAP.map(({ title, links }) => ({ title, links: links.map(({ href, label }) => ({ href, label })) }));
  for (const name of instrument) {
    const html = read(name);
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    const columns = [...footer.matchAll(/<h2 class="site-sitemap-title">([^<]*)<\/h2>\s*<ul>([\s\S]*?)<\/ul>/g)].map(([, title, list]) => ({
      title,
      links: [...list.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map(([, href, label]) => ({ href, label })),
    }));
    assert.deepEqual(columns, shared, name);
  }
});
