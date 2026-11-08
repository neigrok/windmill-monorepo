import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogViolations } from './copyAudit.mjs';

for (const owner of [
  { namespace: 'shell', root: 'src/shell' },
  { namespace: 'ds', root: 'src/design-system' },
  { namespace: 'roadmap', root: 'src/products/roadmap' },
  { namespace: 'journal', root: 'src/products/journal' },
  { namespace: 'gym', root: 'src/products/gym' },
]) {
  test(`${owner.root}: every t() call asks for a literal ${owner.namespace}.* key its catalog holds, with the arguments its message shows, and every message is asked for and parses`, () => {
    assert.deepEqual(catalogViolations(owner), []);
  });
}

test('the catalog audit sees every rule fire on its fixture', () => {
  assert.deepEqual(catalogViolations({ namespace: 'fixture', root: 'test/fixtures/i18n' }), [
    'Fixture.badShape is not fixture.dotted.camelCase',
    'en fixture.broken: message "{count, plural, one {a step}}" expects an other option in the plural at 29',
    "test/fixtures/i18n/Uses.jsx passes t around or binds another t; call it only as t('a.literal.key', { args })",
    'test/fixtures/i18n/Uses.jsx calls t with a key that is not one string literal, so the catalog test cannot see it',
    'test/fixtures/i18n/Uses.jsx:6 passes fixture.greeting extra, which its message never shows',
    'test/fixtures/i18n/Uses.jsx:7 leaves fixture.steps without count',
    'test/fixtures/i18n/Uses.jsx:8 asks for fixture.absent, which test/fixtures/i18n/i18n/en.json does not hold',
    'fixture.unused is in test/fixtures/i18n/i18n/en.json but nothing asks for it',
  ]);
});
