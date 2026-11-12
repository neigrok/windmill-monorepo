import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { Opening } from '../../../../src/products/roadmap/model/Opening.js';
import {
  UnlockRules,
  takesMark,
  treeAttachment,
  unmetPrerequisitesOf,
  owedStepsOf,
  owedCounts,
  unlocksOf,
} from '../../../../src/products/roadmap/model/UnlockRules.js';
import { largeRoadmap } from '../fixtures/largeRoadmap.js';

function tree(nodes) {
  return new SkillTree({ id: 't', title: 'T', nodes });
}

function node(id, prerequisites, extra = {}) {
  return { id, label: id.toUpperCase(), prerequisites, ...extra };
}

test('UnlockRules.derive — completion wins, a step with every prerequisite done is available, the rest locked', () => {
  const t = tree([node('r', []), node('a', ['r']), node('b', ['a']), node('c', ['a'])]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(['r', 'c']), completedAt: {} }), new Map([
    ['r', 'complete'], ['a', 'available'], ['b', 'locked'], ['c', 'complete'],
  ]));
});

test('unmetPrerequisitesOf — the unfinished direct prerequisites in authored order, a repeat counted once', () => {
  const t = tree([node('r', []), node('late', ['r']), node('early', ['r']), node('target', ['late', 'r', 'early', 'late'])]);
  const states = new Map([['r', 'complete'], ['late', 'available'], ['early', 'available'], ['target', 'locked']]);

  assert.deepEqual(unmetPrerequisitesOf(t, states, 'target'), [t.nodesById.get('late'), t.nodesById.get('early')]);
  assert.deepEqual(unmetPrerequisitesOf(t, states, 'late'), []);
});

test('owedStepsOf — every unfinished step in the prerequisite closure, an up-next one included', () => {
  const t = tree([node('r', []), node('a', ['r']), node('b', ['a']), node('side', ['r']), node('target', ['b', 'side'])]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['side', 'available'], ['b', 'locked'], ['target', 'locked']]);

  assert.deepEqual(owedStepsOf(t, states, 'target').map((step) => step.id).sort(), ['a', 'b', 'side']);
  assert.deepEqual(owedStepsOf(t, states, 'a'), []);
});

test('owedCounts — one pass gives every unfinished step the count owedStepsOf walks, on chain, deep and lattice roadmaps', () => {
  const chain = tree(Array.from({ length: 300 }, (_, index) => node(`n${index}`, index === 0 ? [] : [`n${index - 1}`])));
  const deep = new SkillTree(largeRoadmap(300, 'deep'));
  const lattice = tree(Array.from({ length: 300 }, (_, index) => node(`n${index}`, [...new Set([
    ...(index > 0 ? [`n${index - 1}`] : []),
    ...(index > 2 ? [`n${Math.floor(index / 2)}`] : []),
    ...(index > 7 ? [`n${index - 7}`] : []),
  ])])));

  for (const roadmap of [chain, deep, lattice]) {
    const completed = new Set(roadmap.topoOrder().filter((id, index) => index < 120 || (index < 200 && index % 17 === 0)));
    const states = UnlockRules.derive(roadmap, { completed, completedAt: {} });
    const counts = owedCounts(roadmap, states);
    const unfinished = roadmap.nodes.filter((step) => states.get(step.id) !== 'complete');

    assert.deepEqual(
      new Map(unfinished.map((step) => [step.id, counts.get(step.id)])),
      new Map(unfinished.map((step) => [step.id, owedStepsOf(roadmap, states, step.id).length])),
    );
    assert.equal(counts.size, unfinished.length);
    assert.ok(unfinished.some((step) => counts.get(step.id) > 32), 'a fixture owes past one bitset word');
  }
});

test('unlocksOf — the children this completion alone opens, in authored order', () => {
  const t = tree([node('r', []), node('a', ['r']), node('other', ['r']), node('solo', ['a']), node('pair', ['a', 'other']), node('done', ['a'])]);
  const states = new Map([['r', 'complete'], ['a', 'available'], ['other', 'available'], ['solo', 'locked'], ['pair', 'locked'], ['done', 'complete']]);

  assert.deepEqual(unlocksOf(t, states, 'a'), [t.nodesById.get('solo')]);
  assert.deepEqual(unlocksOf(t, states, 'solo'), []);
});


const opened = (state, done, total) => Opening.fromWire({ treeId: 't_opened', title: 'Opened', state, done, total, loop: false });

test('a step whose tree is complete is complete though its prerequisites are not, and unlocks the step behind it', () => {
  const t = tree([node('plan', []), node('sail', ['plan'], { opens: 't_opened', opening: opened('complete', 8, 8) }), node('coast', ['sail'])]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(), completedAt: {} }), new Map([
    ['plan', 'available'], ['sail', 'complete'], ['coast', 'available'],
  ]));
});

test('a mark on a step that opens a tree is ignored: the step is locked or available by its prerequisites until its tree is done', () => {
  const sail = { opens: 't_opened', opening: opened('open', 3, 8) };
  const t = tree([node('plan', []), node('sail', ['plan'], sail), node('coast', ['sail']), node('free', [], sail)]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(['sail', 'free']), completedAt: {} }), new Map([
    ['plan', 'available'], ['sail', 'locked'], ['coast', 'locked'], ['free', 'available'],
  ]));
  assert.deepEqual(UnlockRules.completed(t, { completed: new Set(['plan', 'sail', 'free']) }), new Set(['plan']));
});

test('a step whose pointer dangles follows its mark, and one whose facts are unread is held to a tree not known done', () => {
  const dangling = { opens: 't_gone', opening: Opening.fromWire({ treeId: 't_gone', missing: true }) };
  const unread = { opens: 't_opened', opening: Opening.unread('t_opened') };
  const t = tree([node('bike', [], dangling), node('after', ['bike']), node('late', [], unread), node('behind', ['late'])]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(['bike', 'late']), completedAt: {} }), new Map([
    ['bike', 'complete'], ['after', 'available'], ['late', 'available'], ['behind', 'locked'],
  ]));
  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(), completedAt: {} }), new Map([
    ['bike', 'available'], ['after', 'locked'], ['late', 'available'], ['behind', 'locked'],
  ]));
});

test('a reader’s tree carries no openings and derives as it always did, pointer or no pointer', () => {
  const t = tree([node('plan', []), node('sail', ['plan'], { opens: 't_opened' }), node('coast', ['sail'])]);

  assert.deepEqual(UnlockRules.derive(t, { completed: new Set(['plan', 'sail']), completedAt: {} }), new Map([
    ['plan', 'complete'], ['sail', 'complete'], ['coast', 'available'],
  ]));
});

test('no step that opens a tree takes a hand mark, whatever its tree has come to', () => {
  const openings = [opened('open', 3, 8), opened('complete', 8, 8), Opening.fromWire({ treeId: 't_gone', missing: true }), Opening.unread('t_opened')];

  assert.deepEqual(openings.map((opening) => takesMark({ id: 'sail', opening })), [false, false, false, false]);
  assert.equal(takesMark({ id: 'run' }), true);
});

test('treeAttachment — a mark on the step is set aside, and the steps it alone held up next lock again', () => {
  const year = tree([node('plan', []), node('sail', ['plan']), node('run', ['plan']), node('coast', ['sail']), node('maya', ['sail']), node('race', ['sail', 'run'])]);
  const progress = { completed: new Set(['plan', 'sail']), completedAt: {} };

  assert.deepEqual(treeAttachment(year, progress, 'sail', { complete: false }), { marked: true, relocks: 2 });
  assert.deepEqual(treeAttachment(year, { completed: new Set(['plan', 'sail', 'run', 'coast']), completedAt: {} }, 'sail', { complete: false }),
    { marked: true, relocks: 2 }, 'a step already done stays done, and one up next behind two prerequisites locks');
});

test('treeAttachment — a tree that is complete keeps the step done, so its mark is set aside and nothing locks', () => {
  const year = tree([node('plan', []), node('sail', ['plan']), node('coast', ['sail'])]);
  const progress = { completed: new Set(['plan', 'sail']), completedAt: {} };

  assert.deepEqual(treeAttachment(year, progress, 'sail', { complete: true }), { marked: true, relocks: 0 });
});

test('treeAttachment — a step with no mark has none to set aside and locks nothing, up next or locked', () => {
  const year = tree([node('plan', []), node('sail', ['plan']), node('coast', ['sail'])]);

  assert.deepEqual(treeAttachment(year, { completed: new Set(['plan']), completedAt: {} }, 'sail', { complete: false }), { marked: false, relocks: 0 });
  assert.deepEqual(treeAttachment(year, { completed: new Set(), completedAt: {} }, 'coast', { complete: false }), { marked: false, relocks: 0 });
  assert.deepEqual(treeAttachment(year, { completed: new Set(['plan']), completedAt: {} }, 'sail', { complete: true }), { marked: false, relocks: 0 });
});

test('treeAttachment — changing the tree of a step counts from where the step stands: its mark is already aside', () => {
  const open = new Opening({ treeId: 't_sail', read: true, valid: true, title: 'Learn to sail', done: 3, total: 8 });
  const done = new Opening({ treeId: 't_read', read: true, valid: true, complete: true, title: 'Reading list', done: 12, total: 12 });
  const steps = (opening) => tree([node('plan', []), node('sail', ['plan'], { opening }), node('coast', ['sail']), node('maya', ['sail'])]);
  const progress = { completed: new Set(['plan', 'sail']), completedAt: {} };

  assert.deepEqual(treeAttachment(steps(open), progress, 'sail', { complete: false }), { marked: true, relocks: 0 });
  assert.deepEqual(treeAttachment(steps(done), progress, 'sail', { complete: false }), { marked: true, relocks: 2 });
  assert.deepEqual(treeAttachment(steps(done), progress, 'sail', { complete: true }), { marked: true, relocks: 0 });
  assert.deepEqual(treeAttachment(steps(done), { completed: new Set(['plan']), completedAt: {} }, 'sail', { complete: false }), { marked: false, relocks: 2 });
});

test('UnlockRules.statesUnder — the states a completed set gives, whatever marks and openings would make of it', () => {
  const year = tree([node('plan', []), node('sail', ['plan']), node('coast', ['sail'])]);

  assert.deepEqual(UnlockRules.statesUnder(year, new Set(['plan'])), new Map([['plan', 'complete'], ['sail', 'available'], ['coast', 'locked']]));
  assert.deepEqual(UnlockRules.statesUnder(year, new Set()), new Map([['plan', 'available'], ['sail', 'locked'], ['coast', 'locked']]));
});
