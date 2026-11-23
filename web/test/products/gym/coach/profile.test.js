import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const { COACH_WORDS, GymProfile } = await import('../../../../src/products/gym/coach/profile.js');

test('the room reads the words Coach\'s model reads as the contract\'s own files', () => {
  const contract = (file) => readFileSync(new URL(`../../../../../packages/api-contract/gym/coach/${file}`, import.meta.url), 'utf8');
  assert.equal(COACH_WORDS.prompt, contract('prompt.md'));
  assert.deepEqual(COACH_WORDS.firstContent, JSON.parse(contract('first-content.json')));
  assert.deepEqual(COACH_WORDS.refusals, JSON.parse(contract('refusals.json')));
  assert.deepEqual(Object.keys(COACH_WORDS.firstContent.contextLeads).sort(),
    ['get_session', 'list_exercises', 'list_notes', 'list_routines', 'list_sessions']);
  assert.equal(COACH_WORDS.firstContent.pictureOnlyQuestion, 'Please help me with this photo.');
});

test('the profile offers each seat catalog/3\'s tools but the workout proposal, strict as the catalog says, with the phones\' limits', () => {
  const profile = new GymProfile();
  const bound = profile.of('bound');
  const anon = profile.of('anon');
  assert.equal(bound.tools.some((tool) => tool.name === 'propose_workout_change'), false);
  assert.deepEqual(bound.tools.map((tool) => tool.name).filter((name) => !anon.tools.some((tool) => tool.name === name)).sort(),
    ['revoke_share', 'save_note', 'share_session']);
  for (const tool of bound.tools) assert.equal(tool.strict, profile.catalog.ability(tool.name).strict, tool.name);
  assert.deepEqual([bound.model, bound.effort, anon.effort, bound.output, bound.label, bound.limits],
    ['large', 'medium', 'low', { maxTokens: 2_000, minTokens: 1_024 }, 'coach', { modelCalls: 8, abilityCalls: 12, writes: 6 }]);
  assert.deepEqual(bound.groups.map((group) => [group.name, group.code]), [['routine-proposal', 'one-proposal'], ['note', 'one-note']]);
  assert.equal(bound.refusals['one-proposal'], 'you already wrote a routine proposal this turn; fold both into one document.');
  assert.equal(profile.history([]), '');
});
