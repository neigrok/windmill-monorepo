import test from 'node:test';
import assert from 'node:assert/strict';
import { copyHits, sourceFiles } from './copyAudit.mjs';

test('a migrated root renders no JSX text or copy prop that skips its catalog', () => {
  const migratedRoots = [
    'src/design-system',
    'src/main.jsx',
    'src/shell',
  ];
  const allowedCopy = new Set(['Windmill']);
  assert.deepEqual(migratedRoots.flatMap((root) => sourceFiles(root)).flatMap((file) => copyHits(file, allowedCopy)), []);
});

test('the copy guard finds text children and copy props, and passes symbols, classes and allowed marks', () => {
  assert.deepEqual(sourceFiles('test/fixtures/i18n').flatMap((file) => copyHits(file, new Set(['Windmill']))), [
    'test/fixtures/i18n/Copy.jsx:3 title="Card title"',
    'test/fixtures/i18n/Copy.jsx:5 aria-label="Saved"',
    'test/fixtures/i18n/Copy.jsx:5 aria-label="Save"',
    'test/fixtures/i18n/Copy.jsx:5 text "Save changes"',
    'test/fixtures/i18n/Copy.jsx:6 text " sets"',
    'test/fixtures/i18n/Copy.jsx:7 text "All done"',
    'test/fixtures/i18n/Copy.jsx:8 text "Hello, "',
    'test/fixtures/i18n/Copy.jsx:9 placeholder="Search"',
  ]);
});
