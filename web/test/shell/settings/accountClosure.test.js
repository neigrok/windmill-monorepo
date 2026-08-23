import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closingDeal } from '../../../src/shell/settings/accountClosure.js';
import { PRODUCTS } from '../../../src/shell/products.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

test('the deal names every product the account holds, not the one the screen grew up in', () => {
  const deal = closingDeal(PRODUCTS.map((product) => product.label)).join(' ');
  for (const product of PRODUCTS) assert.equal(deal.includes(product.label), true, `${product.label} is missing from the close deal`);
});

test('the list is built from whatever the registry holds, in its order', () => {
  assert.deepEqual(closingDeal(['One', 'Two', 'Three'])[1],
                   'It closes the whole account, not one room — One, Two and Three alike.');
  assert.deepEqual(closingDeal(['Only'])[1],
                   'It closes the whole account, not one room — Only alike.');
});

test('every registered product is named in the deal, open or not', () => {
  const deal = closingDeal(PRODUCTS.map((product) => product.label)).join(' ');
  for (const product of PRODUCTS) assert.equal(deal.includes(product.label), true);
});

test('the deal promises no erasure and no deadline, because the server performs neither', () => {
  const forbidden = /\b(erased?|deleted|destroyed|wiped|30 days|30-day)\b/i;
  for (const line of closingDeal(PRODUCTS.map((product) => product.label)))
    assert.equal(forbidden.test(line), false, `"${line}" claims something AuthService::closeAccount does not do`);
});

function sourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (['.js', '.jsx', '.mjs'].includes(path.extname(entry.name))) files.push(full);
  }
  return files;
}

test('no product closes the account — the shell owns that door alone', () => {
  const offenders = sourceFiles(path.join(SRC, 'products'))
    .filter((file) => /\bcloseAccount\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => `src/${path.relative(SRC, file)} reaches for closeAccount — the account's close lives once, in shell/settings/CloseAccountSection.jsx`);
  assert.deepEqual(offenders, []);
});

test('settings mounts the close after every product section', () => {
  const page = fs.readFileSync(path.join(SRC, 'shell', 'settings', 'SettingsPage.jsx'), 'utf8');
  assert.equal(page.includes('<CloseAccountSection />'), true);
  assert.equal(page.indexOf('PRODUCT_DATA_SECTIONS.map') < page.indexOf('<CloseAccountSection />'), true);
});
