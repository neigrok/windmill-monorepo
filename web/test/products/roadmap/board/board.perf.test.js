import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { Board } from '../../../../src/products/roadmap/board/Board.js';

test('Board — a 5,000-step lattice with 1,800 steps unfinished builds in under 50 ms, search keystroke included', () => {
  const tree = new SkillTree({ id: 't', title: 'Lattice', nodes: Array.from({ length: 5000 }, (_, index) => ({
    id: `n${index}`,
    label: `Step ${index}`,
    prerequisites: [...new Set([
      ...(index > 0 ? [`n${index - 1}`] : []),
      ...(index > 2 ? [`n${Math.floor(index / 2)}`] : []),
      ...(index > 7 ? [`n${index - 7}`] : []),
    ])],
  })) });
  const progress = { completed: new Set(Array.from({ length: 3200 }, (_, index) => `n${index}`)), completedAt: {} };
  new Board(tree, progress);

  const timings = Array.from({ length: 5 }, (_, run) => {
    const started = performance.now();
    const board = new Board(tree, progress, { search: run % 2 === 0 ? '' : 'step 4' });
    const elapsed = performance.now() - started;
    assert.equal(board.overall.total, 5000);
    return elapsed;
  }).sort((a, b) => a - b);

  assert.ok(timings[2] < 50, `median ${timings[2].toFixed(1)} ms`);
});
