import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const folder = new URL('../../../src/shell/auth/', import.meta.url);
const read = (name) => readFileSync(new URL(name, folder), 'utf8');

test('every auth failure the shell reports is named in OBSERVABILITY.md, and auth-product-words lists exactly the questions it is tagged with', () => {
  const doc = readFileSync(new URL('../../../OBSERVABILITY.md', import.meta.url), 'utf8');
  const code = readdirSync(folder).filter((name) => /\.jsx?$/.test(name)).map(read).join('\n');
  const reported = [...new Set([...code.matchAll(/captureError\('auth', '([a-z-]+)'/g)].map((match) => match[1]))].sort();
  const asked = [...new Set([...read('accountChange.js').matchAll(/this\.ask(?:Now)?\('([a-z]+)'/g)].map((match) => match[1]))].sort();
  const meaning = doc.split('\n').find((line) => line.startsWith('| `auth-product-words` |'))?.split(' | ')[1] ?? '';
  assert.deepEqual({
    named: reported.filter((operation) => doc.includes(`\`${operation}\``)),
    questions: [...new Set([...meaning.matchAll(/`([a-z]+)` \(/g)].map((match) => match[1]))].sort(),
  }, { named: reported, questions: asked });
  assert.deepEqual(asked, ['adoption', 'notice', 'signin', 'signout', 'step']);
});
