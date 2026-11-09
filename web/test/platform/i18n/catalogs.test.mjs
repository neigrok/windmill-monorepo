import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogViolations, translatorViolations } from './copyAudit.mjs';

for (const owner of [
  { namespace: 'shell', root: 'src/shell' },
  { namespace: 'ds', root: 'src/design-system' },
  { namespace: 'roadmap', root: 'src/products/roadmap' },
  { namespace: 'journal', root: 'src/products/journal' },
  { namespace: 'gym', root: 'src/products/gym' },
]) {
  test(`${owner.root}: every t() call asks for a literal ${owner.namespace}.* key its catalog holds, with the arguments its message shows, in every locale, and every message is asked for where it loads and parses`, () => {
    assert.deepEqual(catalogViolations(owner), []);
  });
  test(`${owner.root}: each tier's translator holds and shows every key of the tiers it reads, in every locale`, async () => {
    assert.deepEqual(await translatorViolations(owner), []);
  });
}

test('the catalog audit sees every rule fire on its fixture, read in its two locales and four tiers', () => {
  assert.deepEqual(catalogViolations({ namespace: 'fixture', root: 'test/fixtures/i18n', locales: ['en', 'xx'] }), [
    'test/fixtures/i18n/i18n/entry holds en.json, index.js, not en.json, index.js, xx.json',
    'Fixture.badShape is not fixture.dotted.camelCase',
    'en fixture.broken: message "{count, plural, one {a step}}" expects an other option in the plural at 29',
    'xx fixture.greeting shows {nom} where en shows {name}',
    'fixture.headline is in both test/fixtures/i18n/i18n/entry/en.json and test/fixtures/i18n/i18n/en.json',
    "test/fixtures/i18n/Dynamic.js reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'",
    "test/fixtures/i18n/Relay.js reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'",
    "test/fixtures/i18n/RootAbsolute.jsx reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'",
    "test/fixtures/i18n/SecondBinding.jsx reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'",
    "test/fixtures/i18n/TwoImports.jsx reads its owner's catalog other than as one static, relative import { t } from '…/i18n/index.js'",
    "test/fixtures/i18n/TwoImports.jsx reads its owner's catalog more than once; import t once, from one index",
    "test/fixtures/i18n/Uses.jsx passes t around or binds another t; call it only as t('a.literal.key', { args })",
    'test/fixtures/i18n/Uses.jsx calls t with a key that is not one string literal, so the catalog test cannot see it',
    'test/fixtures/i18n/Uses.jsx:6 passes fixture.greeting extra, which its message never shows',
    'test/fixtures/i18n/Uses.jsx:7 leaves fixture.steps without count',
    'test/fixtures/i18n/Uses.jsx:8 asks for fixture.absent, which test/fixtures/i18n/i18n/en.json does not hold',
    'fixture.headline is in test/fixtures/i18n/i18n/entry/en.json but nothing asks for it',
    'fixture.roomOnly is in test/fixtures/i18n/i18n/entry/en.json, but the latest catalog every file that asks for it reads is test/fixtures/i18n/i18n/en.json',
    'fixture.bothFronts is in test/fixtures/i18n/i18n/app/en.json, but the latest catalog every file that asks for it reads is test/fixtures/i18n/i18n/entry/en.json',
    'fixture.landingRoomOnly is in test/fixtures/i18n/i18n/landing/en.json, but the latest catalog every file that asks for it reads is test/fixtures/i18n/i18n/en.json',
    'fixture.greeting is in test/fixtures/i18n/i18n/en.json, but the latest catalog every file that asks for it reads is test/fixtures/i18n/i18n/entry/en.json',
    'fixture.steps is in test/fixtures/i18n/i18n/en.json, but the latest catalog every file that asks for it reads is test/fixtures/i18n/i18n/entry/en.json',
    'fixture.unused is in test/fixtures/i18n/i18n/en.json but nothing asks for it',
  ]);
});

test('the translator check sees a tier index that forgets a tier it reads or a locale', async () => {
  assert.deepEqual(await translatorViolations({ root: 'test/fixtures/i18n-tiers', locales: ['en', 'xx'] }), [
    'test/fixtures/i18n-tiers/i18n/landing/index.js gives en no tiers.front',
    'test/fixtures/i18n-tiers/i18n/landing/index.js gives xx no 2 keys, tiers.front first',
    'test/fixtures/i18n-tiers/i18n/landing/index.js cannot show tiers.front: i18n: "tiers.front" cannot be shown: the en catalog has no "tiers.front"',
  ]);
});
