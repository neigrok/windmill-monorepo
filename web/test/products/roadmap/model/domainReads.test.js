import test from 'node:test';
import assert from 'node:assert/strict';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { domainReading, readEffects, standingWithout } from '../../../../src/products/roadmap/model/domainReads.js';
import { Board } from '../../../../src/products/roadmap/board/Board.js';

test('delete cost names a step keeping another prerequisite, and a step following two of the steps once', () => {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'wind', label: 'Read the wind', prerequisites: [] },
    { id: 'rig', label: 'Rig the boat', prerequisites: [] },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['wind', 'rig'] },
    { id: 'solo', label: 'Sail solo', prerequisites: ['dock'] },
  ] });
  assert.deepEqual([['wind'], ['rig'], ['wind', 'rig', 'rig'], ['wind', 'rig', 'dock'], []].map((ids) => readEffects(tree, ids).follow),
    [['dock'], ['dock'], ['dock'], ['solo'], []]);
});

test('a selection takes every starting step only when it holds each one the roadmap has', () => {
  const sole = new SkillTree({ id: 'sole', title: 'Sole', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'leaf', label: 'Leaf', prerequisites: ['root'] },
  ] });
  const twoRoots = new SkillTree({ id: 'two', title: 'Two', nodes: [
    { id: 'root', label: 'Root', prerequisites: [] },
    { id: 'other', label: 'Other', prerequisites: [] },
  ] });
  assert.deepEqual([
    [sole, ['root']], [sole, ['leaf', 'root']], [sole, ['leaf']], [sole, []], [sole, ['gone']], [twoRoots, ['root']], [twoRoots, ['root', 'other']],
  ].map(([tree, ids]) => readEffects(tree, ids).takesEveryStart), [true, true, false, false, false, false, true]);
});

test('a step complete by the roadmap it opens keeps its mark set aside, so its Reset relocks nothing, where a marked step relocks', () => {
  const year = new SkillTree({ id: 'year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [] },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], opens: 't_sail',
      opening: Opening.fromWire({ treeId: 't_sail', title: 'Learn to sail', state: 'complete', done: 8, total: 8, loop: false }) },
    { id: 'maya', label: 'Take Maya sailing', prerequisites: ['sail'] },
    { id: 'coast', label: 'Sail the coast', prerequisites: ['plan'] },
  ] });
  const progress = { completed: new Set(['plan', 'sail']), completedAt: {} };
  assert.deepEqual(['sail', 'plan'].map((id) => readEffects(year, [id], progress).relocks), [[], ['coast']]);
});

const opened = (state, done, total) => Opening.fromWire({ treeId: 't_opened', title: 'Opened', state, done, total, loop: false });
const node = (id, prerequisites, extra = {}) => ({ id, label: id.toUpperCase(), prerequisites, ...extra });
const tree = (nodes) => new SkillTree({ id: 't', title: 'T', nodes });

test('a step whose tree is complete is complete though its prerequisites are not, and its mark on a tree not done is set aside', () => {
  const sail = (opening) => node('sail', ['plan'], { opens: 't_opened', opening });
  assert.deepEqual(domainReading(tree([node('plan', []), sail(opened('complete', 8, 8)), node('coast', ['sail'])]), { completed: new Set() }).states,
    new Map([['plan', 'available'], ['sail', 'complete'], ['coast', 'available']]));
  const year = tree([node('plan', []), sail(opened('open', 3, 8)), node('coast', ['sail']), node('free', [], { opens: 't_opened', opening: opened('open', 3, 8) })]);
  assert.deepEqual(domainReading(year, { completed: new Set(['sail', 'free']) }).states,
    new Map([['plan', 'available'], ['sail', 'locked'], ['coast', 'locked'], ['free', 'available']]));
  assert.deepEqual(domainReading(year, { completed: new Set(['plan', 'sail', 'free']) }).completed, new Set(['plan']));
});

test('a step whose pointer dangles follows its mark, one whose facts are unread is held to a tree not known done, and a reader’s pointer is a step like any other', () => {
  const dangling = { opens: 't_gone', opening: Opening.fromWire({ treeId: 't_gone', missing: true }) };
  const unread = { opens: 't_opened', opening: Opening.unread('t_opened') };
  const t = tree([node('bike', [], dangling), node('after', ['bike']), node('late', [], unread), node('behind', ['late'])]);
  assert.deepEqual(domainReading(t, { completed: new Set(['bike', 'late']) }).states,
    new Map([['bike', 'complete'], ['after', 'available'], ['late', 'available'], ['behind', 'locked']]));
  const reader = tree([node('plan', []), node('sail', ['plan'], { opens: 't_opened' }), node('coast', ['sail'])]);
  assert.deepEqual(domainReading(reader, { completed: new Set(['plan', 'sail']) }).states,
    new Map([['plan', 'complete'], ['sail', 'complete'], ['coast', 'available']]));
});

test('a held delete is read through: a step that followed a held one beside a surviving parent follows what the held one followed (D-5)', () => {
  const t = tree([node('plan', []), node('rig', []), node('sail', ['rig']), node('race', ['plan', 'sail'])]);
  const standing = standingWithout(t, ['sail']);
  assert.deepEqual(standing.nodes.map((step) => [step.id, step.prerequisites]), [['plan', []], ['rig', []], ['race', ['plan', 'rig']]]);
  assert.deepEqual(domainReading(standing, { completed: new Set(['plan']) }).states, new Map([['plan', 'complete'], ['rig', 'available'], ['race', 'locked']]),
    'race still owes rig through the held sail, where the hold used to leave it up next');
  assert.equal(standingWithout(t, ['sail']), standing);
  assert.deepEqual(standingWithout(t, ['unknown']).nodes.map((step) => step.id), ['plan', 'rig', 'sail', 'race']);
});

test('what attaching a tree does to a hand’s mark: the steps it alone held up next lock again, none where the tree is complete or the mark is already aside, and nothing where the step holds none', () => {
  const year = tree([node('plan', []), node('sail', ['plan']), node('run', ['plan']), node('coast', ['sail']), node('maya', ['sail']), node('race', ['sail', 'run'])]);
  const attach = (t, completed, complete) => readEffects(t, ['sail'], { completed: new Set(completed) }, { attach: { complete } }).attachRelocks;
  assert.deepEqual(attach(year, ['plan', 'sail'], false), ['coast', 'maya']);
  assert.deepEqual(attach(year, ['plan', 'sail', 'run', 'coast'], false), ['maya', 'race'], 'a step already done stays done, and one up next behind two prerequisites locks');
  assert.deepEqual(attach(year, ['plan', 'sail'], true), []);
  assert.equal(attach(year, ['plan'], false), null);
  const moving = (opening) => tree([node('plan', []), node('sail', ['plan'], { opening }), node('coast', ['sail']), node('maya', ['sail'])]);
  const open = new Opening({ treeId: 't_sail', read: true, valid: true, title: 'Learn to sail', done: 3, total: 8 });
  const done = new Opening({ treeId: 't_read', read: true, valid: true, complete: true, title: 'Reading list', done: 12, total: 12 });
  assert.deepEqual([attach(moving(open), ['plan', 'sail'], false), attach(moving(done), ['plan', 'sail'], false), attach(moving(done), ['plan'], false)],
    [[], ['coast', 'maya'], null]);
});

test('a roadmap under one set of marks is read once for every caller: dated or not, the Board, a state, a step page and a reveal', () => {
  const t = tree([node('plan', []), node('sail', ['plan']), node('coast', ['sail'])]);
  const progress = { completed: new Set(['plan']), completedAt: { plan: 5 } };
  const dated = domainReading(t, progress);
  assert.equal(domainReading(t, progress).graph, dated.graph);
  assert.equal(domainReading(t, { completed: progress.completed }).graph, dated.graph, 'a caller with no dates reads the graph already read');
  assert.equal(readEffects(t, ['sail'], progress).relocks.length, 0);
  assert.deepEqual(new Board(t, progress, { search: 'coast' }).overall, { done: 1, total: 3 });
  assert.equal(domainReading(t, progress).graph, dated.graph, 'a Board query reads no other');
  assert.notEqual(domainReading(t, { completed: new Set(['plan', 'sail']), completedAt: {} }).graph, dated.graph, 'other marks are another reading');
});
