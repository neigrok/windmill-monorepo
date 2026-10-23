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

test('the deal names the grace the server keeps, then deletion for good, in the phones’ words', () => {
  assert.equal(closingDeal([])[4],
    'For 30 days, you can sign in again to bring it all back. After that, it is deleted for good.');
});

test('no line of the deal promises an undo without a limit', () => {
  for (const line of closingDeal(PRODUCTS.map((product) => product.label)))
    assert.equal(/\b(the undo|back whole|any time|forever)\b/i.test(line), false, `"${line}" promises more than 30 days`);
});

test('closing discards this account’s device data, including changes the server has not received', () => {
  assert.equal(closingDeal([])[2],
    'This account’s data on this device is discarded, including changes that haven’t reached the account.');
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
