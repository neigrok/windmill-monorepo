import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roadmapRegistry } from '../domain/vectors.js';
import { KeptChange, keptChanges } from '../../../../src/products/roadmap/kept/KeptChanges.js';

// The notices the domain's own case lists (landing-actions.json, read `cannotLand`): one of each reason and one the
// person is never shown as refused.
const vector = JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/roadmap/domain/landing-actions.json', import.meta.url), 'utf8'))
  .find((entry) => entry.input.read === 'cannotLand');

test('each notice the domain lists is a kept change in the list’s words, a dismissed one is gone, and any other is handed back by its code', () => {
  const notices = [...vector.input.input.notices,
    { id: 'notice:g6/0', scope: 'tree/t_0000000000000001', code: 'scope-dead', dismissed: true, content: { d: [] }, at: 1800000000000 },
    { id: 'notice:g7/0', scope: 'tree/t_0000000000000001', code: 'scope-dead', at: 1800000000000,
      content: { d: [{ t: 'node', id: 'n8', f: { label: ['Read the wind', '1000:0:r_aaaaaaaaaaaa'], description: ['Spot the shifts.', '1000:0:r_aaaaaaaaaaaa'] } }] } }];
  assert.deepEqual(keptChanges(notices, roadmapRegistry, new Map([['a', 'Basics']])), {
    kept: [
      new KeptChange({ id: 'notice:g1/0', reason: 'roadmapDeleted', title: 'Cargo', text: 'Cargo' }),
      new KeptChange({ id: 'notice:g2/0', reason: 'capFilled', title: 'Macros', text: 'Macros' }),
      new KeptChange({ id: 'notice:g3/1', reason: 'accessEnded', title: 'Basics', text: '' }),
      new KeptChange({ id: 'notice:g4/0', reason: 'noteTooLong', title: 'Basics', text: 'Both halves' }),
      new KeptChange({ id: 'notice:g7/0', reason: 'roadmapDeleted', title: 'Read the wind', text: 'Spot the shifts.' }),
    ],
    unexpected: [{ id: 'notice:g5/0', code: 'invalid' }],
  });
});
