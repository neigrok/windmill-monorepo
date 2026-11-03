import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function focusValues(path) {
  const css = readFileSync(new URL(path, import.meta.url), 'utf8');
  return css.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('--focus-ring:'));
}

test('light shared and static focus rings have a canvas gap and terracotta-500 edge; dark stays unchanged', () => {
  assert.deepEqual(focusValues('../../../src/styles/tokens/shadows.css'), [
    '--focus-ring: 0 0 0 2px var(--surface-canvas), 0 0 0 4px var(--accent-terracotta-500);',
    '--focus-ring: 0 0 0 4px rgba(208, 138, 94, 0.4);',
  ]);
  assert.deepEqual(focusValues('../../../scripts/staticPageChrome.css'), [
    '--focus-ring: 0 0 0 2px #F9F5EB, 0 0 0 4px #BC6C42;',
    '--focus-ring: 0 0 0 4px rgba(208, 138, 94, 0.4);',
  ]);
});

test('journal-dark and both gym focus rings retain their product values', () => {
  assert.deepEqual(focusValues('../../../src/styles/tokens/palettes.css'), [
    '--focus-ring: 0 0 0 4px rgba(227, 179, 65, 0.4);',
  ]);
  assert.deepEqual(focusValues('../../../src/products/gym/gymTokens.css'), [
    '--focus-ring: 0 0 0 4px rgba(95, 205, 180, 0.4);',
    '--focus-ring: 0 0 0 4px rgba(76, 67, 116, 0.4);',
  ]);
});
