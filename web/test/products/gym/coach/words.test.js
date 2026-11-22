import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const { COACH_WORDS } = await import('../../../../src/products/gym/coach/words.js');

test('the room reads the words Coach\'s model reads as the contract\'s own files', () => {
  const contract = (file) => readFileSync(new URL(`../../../../../packages/api-contract/gym/coach/${file}`, import.meta.url), 'utf8');
  assert.equal(COACH_WORDS.prompt, contract('prompt.md'));
  assert.deepEqual(COACH_WORDS.firstContent, JSON.parse(contract('first-content.json')));
  assert.deepEqual(COACH_WORDS.refusals, JSON.parse(contract('refusals.json')));
  assert.deepEqual(Object.keys(COACH_WORDS.firstContent.contextLeads).sort(),
    ['get_session', 'list_exercises', 'list_notes', 'list_routines', 'list_sessions']);
  assert.equal(COACH_WORDS.firstContent.pictureOnlyQuestion, 'Please help me with this photo.');
});
