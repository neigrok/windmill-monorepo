// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { Id } from '../../../../src/platform/domain-kit/entities.js';
import { Exercise } from '../../../../src/products/gym/domain/catalogue.js';
import { ProposalDiff } from '../../../../src/products/gym/domain/proposalDiff.js';
import { RoutineChange } from '../../../../src/products/gym/domain/proposals.js';
import { PlanSnapshot, RoutineEntry, SetTarget } from '../../../../src/products/gym/domain/routines.js';
import { Session } from '../../../../src/products/gym/domain/training.js';
import { WorkoutProposal, WorkoutProposalValue } from '../../../../src/products/gym/domain/workoutProposals.js';

const movement = (/** @type {string} */ name) => new Id(name, Exercise);
const entry = (/** @type {string} */ name, /** @type {number} */ reps, /** @type {number} */ kg) => new RoutineEntry(movement(name), [new SetTarget(reps, kg), new SetTarget(reps, kg)]);
const plan = new PlanSnapshot('Upper A', [entry('dumbbell-bench-press', 8, 16), entry('pull-up', 8, 10), entry('lat-pulldown', 10, 50)]);
// Coach's change to Upper A's open workout: pull-ups up front and without the belt, a face pull added at the end.
const proposed = [entry('pull-up', 8, 0), entry('dumbbell-bench-press', 8, 16), entry('lat-pulldown', 10, 50), entry('face-pull', 15, 15)];
const proposal = (/** @type {string} */ state) => new WorkoutProposalValue({ id: new Id('proposal1', WorkoutProposal), sessionId: new Id('session1', Session),
  summary: '', changes: RoutineChange.between(plan.entries, proposed), state });
const form = (/** @type {ProposalDiff} */ diff) => ({ unchanged: diff.unchanged,
  blocks: diff.blocks.map((block) => [block.kind, block.exerciseId?.record ?? null, block.fields.map((field) => [field.label, field.before, field.after])]) });

test('a workout proposal reads as its card\'s blocks against the workout\'s plan while it waits, and counts what it changes', () => {
  const pending = proposal('pending');
  assert.deepEqual(form(ProposalDiff.ofWorkout(pending, plan)), { unchanged: 2, blocks: [
    ['changed', 'pull-up', [['Order', '2nd', '1st'], ['Sets', '2', '2'], ['Reps', '8', '8'], ['Load', '10 kg', '0 kg']]],
    ['added', 'face-pull', [['Sets', null, '2'], ['Reps', null, '15'], ['Load', null, '15 kg']]],
  ] });
  assert.equal(pending.countChanges(plan.entries), 2);
  assert.equal(new WorkoutProposalValue({ ...pending, changeCount: 5 }).countChanges(plan.entries), 5, 'the log\'s count stands once it has one');
});

test('a settled workout proposal reads no moves: the plan no longer holds the order it replaced', () => {
  assert.deepEqual(form(ProposalDiff.ofWorkout(proposal('applied'), plan)), { unchanged: 2, blocks: [
    ['changed', 'pull-up', [['Sets', '2', '2'], ['Reps', '8', '8'], ['Load', '10 kg', '0 kg']]],
    ['added', 'face-pull', [['Sets', null, '2'], ['Reps', null, '15'], ['Load', null, '15 kg']]],
  ] });
  assert.deepEqual(form(ProposalDiff.ofWorkout(proposal('pending'), null)), form(ProposalDiff.ofWorkout(proposal('applied'), plan)),
    'a workout whose plan is unread reads as settled');
});
