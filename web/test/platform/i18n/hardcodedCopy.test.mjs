import test from 'node:test';
import assert from 'node:assert/strict';
import { copyHits, sourceFiles } from './copyAudit.mjs';

test('nothing under src but the showcase renders JSX text, a copy prop or a dialog sentence that skips its catalog', () => {
  const allowedCopy = new Set(['Windmill']);
  const files = sourceFiles('src').filter((file) => !file.startsWith('src/showcase/'));
  assert.deepEqual(files.flatMap((file) => copyHits(file, allowedCopy)), []);
});

test('the copy guard finds text children, copy props even inside listed objects, and dialog sentences, and passes symbols, classes and allowed marks', () => {
  assert.deepEqual(sourceFiles('test/fixtures/i18n').flatMap((file) => copyHits(file, new Set(['Windmill']))), [
    'test/fixtures/i18n/Copy.jsx:3 title="Card title"',
    'test/fixtures/i18n/Copy.jsx:5 aria-label="Saved"',
    'test/fixtures/i18n/Copy.jsx:5 aria-label="Save"',
    'test/fixtures/i18n/Copy.jsx:5 text "Save changes"',
    'test/fixtures/i18n/Copy.jsx:6 text " sets"',
    'test/fixtures/i18n/Copy.jsx:7 text "All done"',
    'test/fixtures/i18n/Copy.jsx:8 text "Hello, "',
    'test/fixtures/i18n/Copy.jsx:9 placeholder="Search"',
    'test/fixtures/i18n/Copy.jsx:12 label="Log past"',
    'test/fixtures/i18n/Copy.jsx:12 label="Delete"',
    'test/fixtures/i18n/Copy.jsx:17 confirm() "Delete this card?"',
    'test/fixtures/i18n/Copy.jsx:18 alert() "Saved"',
  ]);
});
