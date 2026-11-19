import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roadmapRegistry } from '../domain/vectors.js';
import { KeptChange, RoadmapNames, keptChanges } from '../../../../src/products/roadmap/kept/KeptChanges.js';

// The notices the domain's own case lists (landing-actions.json, read `cannotLand`): one of each reason and one the
// person is never shown as refused.
const vector = JSON.parse(readFileSync(new URL('../../../../../packages/api-contract/roadmap/domain/landing-actions.json', import.meta.url), 'utf8'))
  .find((entry) => entry.input.read === 'cannotLand');

test('each notice the domain lists is a kept change in the list’s words, named by what the device read of its own roadmap, and any other is handed back by its code', () => {
  const stamp = '1000:0:r_aaaaaaaaaaaa';
  const notices = [...vector.input.input.notices,
    { id: 'notice:g7/0', scope: 'tree/t_0000000000000002', code: 'scope-dead', at: 1800000000000,
      content: { d: [{ t: 'node', id: 'a', f: { description: ['Spot the shifts.', stamp] } }] } },
    { id: 'notice:g8/0', scope: 'tree/t_0000000000000001', code: 'scope-dead', at: 1800000000000,
      content: { d: [{ t: 'node', id: 'n8', f: { label: ['Read the wind', stamp], description: ['Spot the shifts.', stamp] } }] } }];
  const names = RoadmapNames.read([
    ['t_0000000000000001', [{ t: 'node', id: 'a', f: { label: ['Basics', stamp] } }, { t: 'meta', id: 'meta', f: { title: ['Sailing', stamp] } }]],
    ['t_0000000000000002', [{ t: 'node', id: 'a', f: { label: [' Other basics ', stamp] } }, { t: 'node', id: 'b', f: { label: ['  ', stamp] } }]],
  ]);
  assert.deepEqual(keptChanges(notices, roadmapRegistry, names), {
    kept: [
      new KeptChange({ id: 'notice:g1/0', reason: 'roadmapDeleted', title: 'Cargo', text: 'Cargo' }),
      new KeptChange({ id: 'notice:g2/0', reason: 'capFilled', title: 'Macros', text: 'Macros' }),
      new KeptChange({ id: 'notice:g3/1', reason: 'accessEnded', title: 'Basics', text: '' }),
      new KeptChange({ id: 'notice:g4/0', reason: 'noteTooLong', title: 'Basics', text: 'Both halves' }),
      new KeptChange({ id: 'notice:g7/0', reason: 'roadmapDeleted', title: 'Other basics', text: 'Spot the shifts.' }),
      new KeptChange({ id: 'notice:g8/0', reason: 'roadmapDeleted', title: 'Read the wind', text: 'Spot the shifts.' }),
    ],
    unexpected: [{ id: 'notice:g5/0', code: 'invalid' }],
  });
  assert.deepEqual(keptChanges(notices, roadmapRegistry).kept.map(({ title, worded }) => [title, worded]),
    [['Cargo', true], ['Macros', true], ['', false], ['', true], ['', true], ['Read the wind', true]], 'with no names read, a change is named only by its own words');
});

test('a workspace item the carry-over found past a bound is kept whole for the list, named by its own words or its step', () => {
  const label = 'Reef '.repeat(50).trim();
  assert.deepEqual([
    KeptChange.carried({ id: 'carried:1', subject: { t: 'subtask', id: 's1' }, values: { step: 'a', label } }),
    KeptChange.carried({ id: 'carried:2', subject: { t: 'stepNote', id: 'a' }, values: { text: 'A long note' } }, 'Basics'),
  ], [
    new KeptChange({ id: 'carried:1', reason: 'pastBound', title: label, text: label }),
    new KeptChange({ id: 'carried:2', reason: 'pastBound', title: 'Basics', text: 'A long note' }),
  ]);
});
