// The consent screen that closes an account. Every assertion here is about a SENTENCE, which is
// unusual for a test suite and deliberate: this is the one screen in Windmill whose copy is the
// feature. It said the wrong thing for months and nothing failed, because nothing was watching the
// words.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closingDeal } from '../../../src/shell/settings/accountClosure.js';
import { PRODUCTS } from '../../../src/shell/products.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

// The bug this whole file exists for. The screen used to live inside the roadmap and read "Synced
// copies and share links go. Trees on your devices stay. Export your Markdown archive first." — one
// product's nouns on a button that closes an account holding journal pages and gym sessions too.
test('the deal names every product the account holds, not the one the screen grew up in', () => {
  const deal = closingDeal(PRODUCTS.map((product) => product.label)).join(' ');
  for (const product of PRODUCTS) assert.equal(deal.includes(product.label), true, `${product.label} is missing from the close deal`);
});

// Read off the registry rather than written out, so the day a fourth product is registered its name
// appears here without anybody remembering to come back.
test('the list is built from whatever the registry holds, in its order', () => {
  assert.deepEqual(closingDeal(['One', 'Two', 'Three'])[1],
                   'It closes the whole account, not one room — One, Two and Three alike.');
  assert.deepEqual(closingDeal(['Only'])[1],
                   'It closes the whole account, not one room — Only alike.');
});

// A PRE-OPEN PRODUCT IS STILL THE ACCOUNT'S. Gym holds `shell.status: 'pre-open'`, which removes it
// from the rail, the tabs and the home grid — and must NOT remove it from here, because the account
// holds a lifter's sessions whether or not the web has grown a door onto them.
test('a pre-open product is named in the deal all the same', () => {
  const preOpen = PRODUCTS.filter((product) => product.shell?.status !== 'open');
  assert.equal(preOpen.length > 0, true, 'this test is vacuous with no pre-open product — check the registry');
  const deal = closingDeal(PRODUCTS.map((product) => product.label)).join(' ');
  for (const product of preOpen) assert.equal(deal.includes(product.label), true);
});

// THE CLAIM THAT MAY NOT BE MADE BACK WITHOUT THE SERVER MAKING IT TRUE.
// backend/platform/application/AuthService.cpp:230-242 revokes every session, disconnects every
// grant, and stamps `users.deleted_at`. Nothing else. No job ever removes a closed account's rows
// (`deleteUser` has one caller, the empty-account fold), and `revived()` puts no window on the undo,
// so both "your account closes in 30 days" and "synced copies … go" were promises the server does
// not keep. When a reaper ships, this test is where the erasure line gets re-authorized — deliberately
// so: adding it means editing this list and stating that the server now does it.
test('the deal promises no erasure and no deadline, because the server performs neither', () => {
  const forbidden = /\b(erased?|deleted|destroyed|wiped|30 days|30-day)\b/i;
  for (const line of closingDeal(PRODUCTS.map((product) => product.label)))
    assert.equal(forbidden.test(line), false, `"${line}" claims something AuthService::closeAccount does not do`);
});

// ONE ACCOUNT, ONE DOOR THAT CLOSES IT. The close moved into the shell because it acts on the
// account; the matching rule is that a product may not grow a second one. A product that imports
// closeAccount is that second door, whatever it calls its section.
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

// The section the settings page actually mounts, and mounts LAST — the deal says "export what you
// want to keep first", and the exports it means are the product data sections directly above it.
test('settings mounts the close after every product section', () => {
  const page = fs.readFileSync(path.join(SRC, 'shell', 'settings', 'SettingsPage.jsx'), 'utf8');
  assert.equal(page.includes('<CloseAccountSection />'), true);
  assert.equal(page.indexOf('PRODUCT_DATA_SECTIONS.map') < page.indexOf('<CloseAccountSection />'), true);
});
