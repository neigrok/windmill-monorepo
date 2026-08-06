// The journal's export document. GET /v1/journal/export was live and unreachable — the settings
// section is the caller now, and this is the shape it hands over. Two things it must never do:
// translate a step on a scale into a word (the canvas grades nothing, so neither may its archive),
// and print a day nobody wrote as if it were a page.

import test from 'node:test';
import assert from 'node:assert/strict';

import { journalMarkdown } from '../../../../src/products/journal/settings/journalExport.js';

test('journalMarkdown — one document, oldest first, scales as the fractions they are', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-04', body: 'slept badly', mood: 2, energy: 1, source: 'typed', stamp: '1:0:a' },
    { day: '2026-08-02', body: 'better', mood: 0, energy: 0, source: 'typed', stamp: '1:0:a' },
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
    '_mood 2/5 · energy 1/3_',
    '',
    'slept badly',
    '',
  ].join('\n'));
});

// A day with a mood and no words was still a day someone showed up for — the same rule the canvas
// and the phone draw by. A day nobody touched at all is simply not in the archive.
test('journalMarkdown — a scale with no words is a page, an untouched day is not', () => {
  const markdown = journalMarkdown([
    { day: '2026-08-01', body: '', mood: 4, energy: 0 },
    { day: '2026-08-03', body: '', mood: 0, energy: 0 },
  ]);

  assert.equal(markdown, '# Windmill journal\n\n## 2026-08-01\n\n_mood 4/5_\n');
});

test('journalMarkdown — an account with nothing in it is an honest empty document', () => {
  assert.equal(journalMarkdown([]), '# Windmill journal\n\n');
});
