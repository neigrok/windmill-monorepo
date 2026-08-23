import test from 'node:test';
import assert from 'node:assert/strict';

import { journalMarkdown } from '../../../../src/products/journal/settings/journalExport.js';

test('journalMarkdown — one document, oldest first, scales as the fractions they are', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-04', body: 'slept badly', mood: 2, energy: 1, source: 'typed', stamp: '1:0:a' },
    { day: '2026-08-02', body: 'better', mood: null, energy: null, source: 'typed', stamp: '1:0:a' },
  ]);

  assert.equal(markdown, [
    '# Windmill journal',
    '',
    '## 2026-08-02',
    '',
    'better',
    '',
    '## 2026-08-04',
    '',
    '_mood 2/10 · energy 1/10_',
    '',
    'slept badly',
    '',
  ].join('\n'));
});

test('journalMarkdown — a scale with no words is a page, an untouched day is not', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-01', body: '', mood: 4, energy: null },
    { day: '2026-08-03', body: '', mood: null, energy: null },
  ]);

  assert.equal(markdown, '# Windmill journal\n\n## 2026-08-01\n\n_mood 4/10_\n');
});

test('journalMarkdown — an account with nothing in it is an honest empty document', () => {
  assert.equal(journalMarkdown([]), '# Windmill journal\n\n');
});
