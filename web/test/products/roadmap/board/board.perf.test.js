import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { Board } from '../../../../src/products/roadmap/board/Board.js';
import { PrerequisiteChoices } from '../../../../src/products/roadmap/step/StepDraft.js';

// Each timed build is of a roadmap the room has not read yet, so it pays the domain's one reading of it, records and
// graph, as the room does once for each change of the roadmap or the marks.
test('Board — a 5,000-step lattice with 1,800 steps unfinished builds cold in under 50 ms, its reading included, search keystroke included', () => {
  const lattice = () => new SkillTree({ id: 't', title: 'Lattice', nodes: Array.from({ length: 5000 }, (_, index) => ({
    id: `n${index}`,
    label: `Step ${index}`,
    prerequisites: [...new Set([
      ...(index > 0 ? [`n${index - 1}`] : []),
      ...(index > 2 ? [`n${Math.floor(index / 2)}`] : []),
      ...(index > 7 ? [`n${index - 7}`] : []),
    ])],
  })) });
  const marks = () => ({ completed: new Set(Array.from({ length: 3200 }, (_, index) => `n${index}`)), completedAt: {} });
  new Board(lattice(), marks());

  const timings = Array.from({ length: 5 }, (_, run) => {
    const tree = lattice();
    const progress = marks();
    const started = performance.now();
    const board = new Board(tree, progress, { search: run % 2 === 0 ? '' : 'step 4' });
    const elapsed = performance.now() - started;
    assert.equal(board.overall.total, 5000);
    return elapsed;
  }).sort((a, b) => a - b);

  assert.ok(timings[2] < 50, `median ${timings[2].toFixed(1)} ms`);
});

test('PrerequisiteChoices — search and paging across 5,000 steps stay under 50 ms', () => {
  const tree = new SkillTree({ id: 'coast', title: 'Coastal navigation handbook', nodes: Array.from({ length: 5000 }, (_, index) => ({
    id: `n${index}`,
    label: index < 64 ? `Coastal navigation ${index}` : `Step ${index}`,
    prerequisites: index < 3230 ? [] : ['n3200'],
  })) });
  const completed = new Set(Array.from({ length: 3200 }, (_, index) => `n${index}`));
  const choices = new PrerequisiteChoices(tree, completed);
  assert.deepEqual(new Board(tree, { completed, completedAt: {} }).columns.map((column) => column.count), [1770, 30, 3200]);
  const timings = Array.from({ length: 5 }, () => {
    const started = performance.now();
    const searched = choices.search('coastal').toggle('n63').more();
    const elapsed = performance.now() - started;
    assert.deepEqual({ total: searched.total, count: searched.count, shown: searched.rows.length, selected: searched.selectedIds }, {
      total: 5000, count: 64, shown: 40, selected: ['n63'],
    });
    return elapsed;
  }).sort((a, b) => a - b);
  assert.ok(timings[2] < 50, `median ${timings[2].toFixed(1)} ms`);
});
