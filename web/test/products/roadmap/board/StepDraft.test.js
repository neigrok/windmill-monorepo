import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { StepDraft, CreateStepRequest, PrerequisiteChoices } from '../../../../src/products/roadmap/board/StepDraft.js';

function sailing(nodes = []) {
  return new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'parts', label: 'Name the boat parts', prerequisites: [], color: 'sky' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['wind'], color: 'terracotta' },
    ...nodes,
  ] });
}

test('StepDraft — a blank draft is clean and requires a trimmed name', () => {
  const draft = new StepDraft({ id: 'new' });
  assert.deepEqual({ ...draft }, { id: 'new', name: '', description: '', color: 'sky', prerequisites: [] });
  assert.equal(draft.dirty, false);
  assert.deepEqual(draft.validate(), { name: 'Enter a name for this step.' });
  assert.deepEqual(draft.with({ name: ' \n ' }).validate(), { name: 'Enter a name for this step.' });
  assert.deepEqual(draft.with({ name: '  Reefing basics  ' }).validate(), { name: null });
  assert.throws(() => draft.toCreateRequest(), { name: 'TypeError', message: 'A step requires a non-empty label' });
});

test('StepDraft — every authored field contributes to dirty and returning to blank clears it', () => {
  const blank = new StepDraft({ id: 'new' });
  for (const change of [{ name: ' ' }, { description: ' ' }, { color: 'gold' }, { prerequisites: ['parts'] }]) {
    assert.equal(blank.with(change).dirty, true);
  }
  assert.equal(blank.with({ name: 'Reefing basics', color: 'gold', description: 'Reduce sail', prerequisites: ['parts'] })
    .with({ name: '', color: 'sky', description: '', prerequisites: [] }).dirty, false);
});

test('StepDraft — its minted id survives edits and its request owns frozen, deduplicated prerequisite data', () => {
  const blank = new StepDraft();
  const another = new StepDraft();
  assert.equal(typeof blank.id, 'string');
  assert.notEqual(blank.id, another.id);
  const selected = ['wind', 'parts', 'wind'];
  const draft = blank.with({ id: 'ignored', name: '  Reefing basics  ', description: '  Reduce sail  ', color: 'gold', prerequisites: selected });
  selected.push('dock');
  assert.equal(draft.id, blank.id);
  const request = draft.toCreateRequest(sailing());
  assert.ok(request instanceof CreateStepRequest);
  assert.deepEqual({ ...request }, {
    id: blank.id, label: 'Reefing basics', description: '  Reduce sail  ', color: 'gold', prerequisites: ['wind', 'parts'],
  });
  assert.equal(Object.isFrozen(draft), true);
  assert.equal(Object.isFrozen(draft.prerequisites), true);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.prerequisites), true);
  assert.deepEqual(draft.toCreateRequest(sailing()), request);
});

test('StepDraft — placement derives an extra root, all-done prerequisites and each unmet count', () => {
  const tree = sailing();
  const draft = new StepDraft({ id: 'new' });
  const completed = new Set(['parts']);
  assert.deepEqual(draft.placement(tree, completed), { column: 'upNext', body: 'No prerequisites: lands in Up next.' });
  assert.deepEqual(draft.with({ prerequisites: ['parts'] }).placement(tree, completed), {
    column: 'upNext', body: 'Prerequisites done: lands in Up next.',
  });
  assert.deepEqual(draft.with({ prerequisites: ['parts', 'wind'] }).placement(tree, completed), {
    column: 'locked', body: 'Read the wind isn’t done',
  });
  assert.deepEqual(draft.with({ prerequisites: ['bowline', 'parts', 'wind'] }).placement(tree, completed), {
    column: 'locked', body: 'Tie a bowline and Read the wind aren’t done',
  });
  assert.deepEqual(draft.with({ prerequisites: ['wind', 'dock', 'bowline', 'parts'] }).placement(tree, completed), {
    column: 'locked', body: 'Read the wind and 2 more aren’t done',
  });
  assert.deepEqual(draft.placement(new SkillTree({ id: 'empty', title: '', nodes: [] }), new Set()), {
    column: 'upNext', body: 'No prerequisites: lands in Up next.',
  });
});

test('StepDraft — a remotely deleted prerequisite leaves the draft, preview and request silently', () => {
  const tree = sailing();
  const draft = new StepDraft({ id: 'new', name: 'Reefing basics', prerequisites: ['gone', 'parts'] });
  const reconciled = draft.reconcile(tree);
  assert.deepEqual({ ...reconciled }, { id: 'new', name: 'Reefing basics', description: '', color: 'sky', prerequisites: ['parts'] });
  assert.equal(reconciled.reconcile(tree), reconciled);
  assert.deepEqual(draft.placement(tree, new Set(['parts'])), { column: 'upNext', body: 'Prerequisites done: lands in Up next.' });
  assert.deepEqual(draft.toCreateRequest(tree).prerequisites, ['parts']);
  assert.deepEqual(draft.prerequisites, ['gone', 'parts']);
});

test('StepDraft — placement names blank prerequisites without changing nonblank authored titles', () => {
  const tree = new SkillTree({ id: 'blank', title: '', nodes: [
    { id: 'empty', label: '', prerequisites: [] },
    { id: 'missing', prerequisites: [] },
    { id: 'spaces', label: '  ', prerequisites: [] },
    { id: 'padded', label: '  Read the wind  ', prerequisites: [] },
  ] });
  const draft = new StepDraft({ id: 'new' });
  for (const id of ['empty', 'missing', 'spaces']) {
    assert.deepEqual(draft.with({ prerequisites: [id] }).placement(tree, new Set()), {
      column: 'locked', body: 'Unnamed step isn’t done',
    });
  }
  assert.deepEqual(draft.with({ prerequisites: ['padded'] }).placement(tree, new Set()), {
    column: 'locked', body: '  Read the wind   isn’t done',
  });
});

test('PrerequisiteChoices — results group Done, Up next, Locked with state words and authored order in each group', () => {
  const choices = new PrerequisiteChoices(sailing(), new Set(['parts']), { selected: ['wind'] });
  assert.deepEqual(choices.rows, [
    { id: 'parts', label: 'Name the boat parts', color: 'sky', state: 'Done', column: 'done', context: null, selected: false },
    { id: 'wind', label: 'Read the wind', color: 'sky', state: 'Up next', column: 'upNext', context: null, selected: true },
    { id: 'bowline', label: 'Tie a bowline', color: 'olive', state: 'Up next', column: 'upNext', context: null, selected: false },
    { id: 'dock', label: 'Leave the dock', color: 'terracotta', state: 'Locked', column: 'locked', context: null, selected: false },
  ]);
  assert.deepEqual({ count: choices.count, total: choices.total, fits: choices.fits, hasMore: choices.hasMore, nextCount: choices.nextCount }, {
    count: 4, total: 4, fits: true, hasMore: false, nextCount: 0,
  });
});

test('PrerequisiteChoices — only colliding titles carry starting-step or first-prerequisite context', () => {
  const choices = new PrerequisiteChoices(sailing([
    { id: 'chart-root', label: '  Read a chart  ', prerequisites: [] },
    { id: 'chart-after', label: 'Read a chart', prerequisites: ['wind', 'parts'] },
  ]), new Set(['parts']));
  assert.deepEqual(choices.search('  READ A CHART ').rows, [
    { id: 'chart-root', label: '  Read a chart  ', color: 'terracotta', state: 'Up next', column: 'upNext', context: 'a starting step', selected: false },
    { id: 'chart-after', label: 'Read a chart', color: 'terracotta', state: 'Locked', column: 'locked', context: 'after Read the wind', selected: false },
  ]);
  assert.deepEqual(choices.search('wind').rows.map((row) => row.context), [null]);
});

test('PrerequisiteChoices — blank titles share the step detail fallback in rows, search and collision context', () => {
  const tree = new SkillTree({ id: 'blank', title: '', nodes: [
    { id: 'empty', label: '', prerequisites: [] },
    { id: 'missing', prerequisites: [] },
    { id: 'spaces', label: '  ', prerequisites: ['empty'] },
    { id: 'named', label: 'Unnamed step', prerequisites: ['missing'] },
  ] });
  const choices = new PrerequisiteChoices(tree, new Set(), { selected: ['spaces'] }).search('unnamed');
  assert.deepEqual(choices.rows, [
    { id: 'empty', label: 'Unnamed step', color: 'terracotta', state: 'Up next', column: 'upNext', context: 'a starting step', selected: false },
    { id: 'missing', label: 'Unnamed step', color: 'terracotta', state: 'Up next', column: 'upNext', context: 'a starting step', selected: false },
    { id: 'spaces', label: 'Unnamed step', color: 'terracotta', state: 'Locked', column: 'locked', context: 'after Unnamed step', selected: true },
    { id: 'named', label: 'Unnamed step', color: 'terracotta', state: 'Locked', column: 'locked', context: 'after Unnamed step', selected: false },
  ]);
  assert.deepEqual(choices.selected, [choices.rows[2]]);
  assert.equal(choices.count, 4);
});

test('PrerequisiteChoices — selection survives queries, clearing, no matches and chip removal without writing the draft', () => {
  const tree = sailing();
  const draft = new StepDraft({ id: 'new', prerequisites: ['parts'] });
  const original = new PrerequisiteChoices(tree, new Set(['parts']), { selected: draft.prerequisites });
  const wind = original.search('wind').toggle('wind');
  assert.deepEqual(wind.selectedIds, ['parts', 'wind']);
  assert.deepEqual(wind.search('bowline').selectedIds, ['parts', 'wind']);
  const empty = wind.search('astronomy');
  assert.deepEqual({ count: empty.count, rows: empty.rows, selected: empty.selectedIds }, { count: 0, rows: [], selected: ['parts', 'wind'] });
  assert.deepEqual(empty.search('').selected.map((row) => row.label), ['Name the boat parts', 'Read the wind']);
  assert.deepEqual(empty.toggle('parts').selectedIds, ['wind']);
  assert.deepEqual(draft.prerequisites, ['parts']);
  assert.deepEqual(original.selectedIds, ['parts']);
});

test('PrerequisiteChoices — Apply compares selection membership and ignores ordering and deleted ids', () => {
  const choices = new PrerequisiteChoices(sailing(), new Set(), { selected: ['parts', 'wind', 'wind', 'gone'] });
  assert.deepEqual(choices.selectedIds, ['parts', 'wind']);
  assert.equal(choices.differsFrom(['wind', 'parts']), false);
  assert.equal(choices.differsFrom(['parts', 'wind', 'gone']), false);
  assert.equal(choices.differsFrom(['parts']), true);
  assert.equal(choices.toggle('wind').toggle('wind').differsFrom(['parts', 'wind']), false);
  assert.equal(choices.toggle('missing'), choices);
});

test('PrerequisiteChoices — page counts cover all model matches and each page adds at most twenty', () => {
  const tree = new SkillTree({ id: 'large', title: '', nodes: Array.from({ length: 70 }, (_, index) => ({
    id: `n${index}`, label: index < 64 ? `Coastal ${index}` : `Wind ${index}`, prerequisites: [],
  })) });
  const choices = new PrerequisiteChoices(tree, new Set(), { selected: ['n63'] }).search('coastal');
  assert.deepEqual([choices.total, choices.count, choices.rows.length, choices.nextCount, choices.fits], [70, 64, 20, 20, false]);
  assert.deepEqual(choices.rows.map((row) => row.id), Array.from({ length: 20 }, (_, index) => `n${index}`));
  const second = choices.more();
  const third = second.more();
  const last = third.more();
  assert.deepEqual([second.rows.length, third.rows.length, third.nextCount, last.rows.length, last.hasMore], [40, 60, 4, 64, false]);
  assert.equal(last.more(), last);
  assert.deepEqual(last.selectedIds, ['n63']);
  assert.deepEqual([last.search('wind').rows.length, last.search('coastal').rows.length], [6, 20]);
  for (const [total, fits] of [[8, true], [9, false]]) {
    const small = new SkillTree({ id: 'small', title: '', nodes: tree.nodes.slice(0, total) });
    assert.equal(new PrerequisiteChoices(small, new Set()).fits, fits);
  }
});

test('PrerequisiteChoices — revalidation silently drops deleted choices and recomputes candidate states', () => {
  const tree = sailing();
  const completed = new Set();
  const choices = new PrerequisiteChoices(tree, completed, { selected: ['parts', 'wind'], query: 'wind' });
  assert.equal(choices.reconcile(tree, completed), choices);
  const reduced = new SkillTree({ id: 'sail', title: '', nodes: [{ id: 'parts', label: 'Name the boat parts', prerequisites: [] }] });
  const next = choices.reconcile(reduced, new Set(['parts']));
  assert.deepEqual({ query: next.query, rows: next.rows, selected: next.selectedIds }, { query: 'wind', rows: [], selected: ['parts'] });
  assert.deepEqual(next.selected.map((row) => row.state), ['Done']);
  assert.deepEqual(choices.selectedIds, ['parts', 'wind']);
});
