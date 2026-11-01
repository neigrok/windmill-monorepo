import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { advanceProgress } from '../../../../src/products/roadmap/model/progress.js';
import { Board, BoardQuery, BOARD_SORTS, DONE_RECENT_LIMIT, arrivals } from '../../../../src/products/roadmap/board/Board.js';

function learnToSail(extra = []) {
  const imported = Date.parse('2026-10-20T09:00:00Z');
  return new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', createdMs: imported,
      description: 'Book a beginner course with time on the water.' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', createdMs: imported,
      description: 'Identify the mast, boom, hull and rudder.' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', createdMs: imported,
      description: 'Set the sails and check the boat before launch.' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', createdMs: Date.parse('2026-10-22T10:00:00Z'),
      description: 'Tie a secure loop that is easy to undo.' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', createdMs: Date.parse('2026-10-21T10:00:00Z'),
      description: 'Learn to spot shifts in wind direction.' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', createdMs: imported,
      description: 'Cast off safely and steer clear of the dock.' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', createdMs: imported,
      description: 'Practise reaching, tacking and returning to start.' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', createdMs: imported,
      description: 'Plan and sail a short route on your own.' },
    ...extra,
  ] });
}

function initialProgress() {
  return { completed: new Set(['course', 'parts', 'rig']), completedAt: { course: 100, parts: 200, rig: 300 } };
}

function render(board) {
  const reason = (card) => {
    if (card.needs) return ` · needs ${card.needs.need.label} +${card.needs.extra} · ${card.needs.toGo} to go`;
    if (card.unlocks) return ` · unlocks ${card.unlocks.first.label} +${card.unlocks.extra}`;
    return '';
  };
  return [
    ...board.columns.flatMap((column) => [
      `${column.name} ${column.count}`,
      ...column.cards.map((card) => `  ${card.step.label}${reason(card)}`),
    ]),
    `progress ${board.overall.done}/${board.overall.total}`,
  ].join('\n');
}

test('Board — the initial Learn to sail roadmap: 3 locked, 2 up next, 3 done, each with its reason', () => {
  assert.equal(render(new Board(learnToSail(), initialProgress())), [
    'locked 3',
    '  Leave the dock · needs Read the wind +0 · 1 to go',
    '  Sail a triangle · needs Leave the dock +0 · 2 to go',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 2',
    '  Read the wind · unlocks Leave the dock +0',
    '  Tie a bowline',
    'done 3',
    '  Rig the boat',
    '  Name the boat parts',
    '  Choose a sailing course',
    'progress 3/8',
  ].join('\n'));
});

test('Board — a card carries its step, its column and structured reasons, never strings', () => {
  const tree = learnToSail();
  const board = new Board(tree, initialProgress());
  const [solo] = board.locked.cards.filter((card) => card.id === 'solo');
  const [wind] = board.upNext.cards.filter((card) => card.id === 'wind');
  const [rig] = board.done.cards.filter((card) => card.id === 'rig');

  assert.deepEqual(
    { step: solo.step, column: solo.column, unlockCount: solo.unlockCount, needs: solo.needs, unlocks: solo.unlocks },
    { step: tree.nodesById.get('solo'), column: 'locked', unlockCount: 0,
      needs: { need: tree.nodesById.get('triangle'), extra: 1, toGo: 4 }, unlocks: null },
  );
  assert.deepEqual(
    { step: wind.step, column: wind.column, unlockCount: wind.unlockCount, needs: wind.needs, unlocks: wind.unlocks },
    { step: tree.nodesById.get('wind'), column: 'upNext', unlockCount: 1,
      needs: null, unlocks: { first: tree.nodesById.get('dock'), extra: 0 } },
  );
  assert.deepEqual(
    { step: rig.step, column: rig.column, unlockCount: rig.unlockCount, needs: rig.needs, unlocks: rig.unlocks },
    { step: tree.nodesById.get('rig'), column: 'done', unlockCount: 0, needs: null, unlocks: null },
  );
  assert.deepEqual(board.columns, [board.locked, board.upNext, board.done]);
});

test('Board — completing Read the wind moves Leave the dock up next and shortens every distance behind it', () => {
  const tree = learnToSail();
  const progress = advanceProgress(initialProgress(), ['wind'], 'complete', 400);

  assert.equal(render(new Board(tree, progress)), [
    'locked 2',
    '  Sail a triangle · needs Leave the dock +0 · 1 to go',
    '  Sail solo · needs Sail a triangle +1 · 3 to go',
    'upNext 2',
    '  Leave the dock · unlocks Sail a triangle +0',
    '  Tie a bowline',
    'done 4',
    '  Read the wind',
    '  Rig the boat',
    '  Name the boat parts',
    '  Choose a sailing course',
    'progress 4/8',
  ].join('\n'));
});

test('Board — resetting Name the boat parts regroups its dependents and leaves Rig the boat done', () => {
  const tree = learnToSail();
  const progress = advanceProgress(initialProgress(), ['parts'], 'none', 400);

  assert.equal(render(new Board(tree, progress)), [
    'locked 5',
    '  Read the wind · needs Name the boat parts +0 · 1 to go',
    '  Tie a bowline · needs Name the boat parts +0 · 1 to go',
    '  Leave the dock · needs Read the wind +0 · 2 to go',
    '  Sail a triangle · needs Leave the dock +0 · 3 to go',
    '  Sail solo · needs Sail a triangle +1 · 5 to go',
    'upNext 1',
    '  Name the boat parts · unlocks Tie a bowline +1',
    'done 2',
    '  Rig the boat',
    '  Choose a sailing course',
    'progress 2/8',
  ].join('\n'));
});

test('Board — a new step behind Read the wind arrives locked, one to go, and grows the total', () => {
  const tree = learnToSail([{ id: 'reef', label: 'Reefing basics', prerequisites: ['wind'], color: 'olive',
    description: 'How to reduce sail area safely in stronger wind.' }]);
  const board = new Board(tree, initialProgress());

  assert.deepEqual(board.locked.cards.map((card) => [card.step.label, card.needs.need.label, card.needs.extra, card.needs.toGo]), [
    ['Leave the dock', 'Read the wind', 0, 1],
    ['Reefing basics', 'Read the wind', 0, 1],
    ['Sail a triangle', 'Leave the dock', 0, 2],
    ['Sail solo', 'Sail a triangle', 1, 4],
  ]);
  assert.deepEqual(board.overall, { done: 3, total: 9 });
  assert.equal(board.columnOf('reef'), 'locked');
});

test('Board — roadmap order breaks a distance tie by most unlocks, then keeps the authored order', () => {
  const tree = new SkillTree({ id: 't', title: 'T', nodes: [
    { id: 'r', label: 'Root', prerequisites: [] },
    { id: 'quiet', label: 'Quiet', prerequisites: ['r'] },
    { id: 'late', label: 'Late', prerequisites: ['r'] },
    { id: 'loud', label: 'Loud', prerequisites: ['r'] },
    { id: 'x', label: 'X', prerequisites: ['loud'] },
    { id: 'y', label: 'Y', prerequisites: ['loud'] },
    { id: 'deep', label: 'Deep', prerequisites: ['x'] },
  ] });
  const board = new Board(tree, { completed: new Set(['r']), completedAt: { r: 1 } });

  assert.equal(render(board), [
    'locked 3',
    '  X · needs Loud +0 · 1 to go',
    '  Y · needs Loud +0 · 1 to go',
    '  Deep · needs X +0 · 2 to go',
    'upNext 3',
    '  Loud · unlocks X +1',
    '  Quiet',
    '  Late',
    'done 1',
    '  Root',
    'progress 1/7',
  ].join('\n'));
});

test('Board — up next has nothing to go, so it reads most unlocks first, however deep the step sits', () => {
  const tree = new SkillTree({ id: 't', title: 'T', nodes: [
    { id: 'r', label: 'Root', prerequisites: [] },
    { id: 'a', label: 'A', prerequisites: ['r'] },
    { id: 'near', label: 'Near', prerequisites: ['r'] },
    { id: 'far', label: 'Far', prerequisites: ['a'] },
    { id: 'z', label: 'Z', prerequisites: ['far'] },
  ] });
  const board = new Board(tree, { completed: new Set(['r', 'a']), completedAt: { r: 1, a: 2 } });

  assert.deepEqual(board.upNext.cards.map((card) => [card.id, card.unlockCount]), [['far', 1], ['near', 0]]);
});

test('Board — the kind filter is an OR across hues and narrows every column, never progress', () => {
  const tree = learnToSail();

  assert.equal(render(new Board(tree, initialProgress(), { kinds: ['gold'] })), [
    'locked 1',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 0',
    'done 0',
    'progress 3/8',
  ].join('\n'));
  assert.equal(render(new Board(tree, initialProgress(), { kinds: ['sky'] })), [
    'locked 0',
    'upNext 1',
    '  Read the wind · unlocks Leave the dock +0',
    'done 1',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
  assert.equal(render(new Board(tree, initialProgress(), { kinds: new Set(['gold', 'sky']) })), [
    'locked 1',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 1',
    '  Read the wind · unlocks Leave the dock +0',
    'done 1',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
});

test('Board — an unpainted step wears the default hue under the filter', () => {
  const tree = new SkillTree({ id: 't', title: 'T', nodes: [
    { id: 'r', label: 'Root', prerequisites: [] },
    { id: 'a', label: 'A', prerequisites: ['r'], color: 'sky' },
  ] });

  assert.deepEqual(new Board(tree, { completed: new Set(), completedAt: {} }, { kinds: ['terracotta'] }).upNext.cards.map((card) => card.id), ['r']);
});

test('Board — search matches a title or a description, ignoring case, and composes with the filter', () => {
  const tree = learnToSail();

  assert.equal(render(new Board(tree, initialProgress(), { search: '  BOAT ' })), [
    'locked 0',
    'upNext 0',
    'done 2',
    '  Rig the boat',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
  assert.equal(render(new Board(tree, initialProgress(), { search: 'Rudder' })), [
    'locked 0',
    'upNext 0',
    'done 1',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
  assert.equal(render(new Board(tree, initialProgress(), { search: 'boat', kinds: ['sky'] })), [
    'locked 0',
    'upNext 0',
    'done 1',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
  assert.equal(render(new Board(tree, initialProgress(), { search: 'astronomy' })), [
    'locked 0',
    'upNext 0',
    'done 0',
    'progress 3/8',
  ].join('\n'));
});

test('Board — the Read the wind branch holds six steps and still reads status from the whole roadmap', () => {
  const tree = learnToSail();
  const board = new Board(tree, initialProgress(), { branch: 'wind' });

  assert.equal(board.branch, tree.nodesById.get('wind'));
  assert.equal(render(board), [
    'locked 3',
    '  Leave the dock · needs Read the wind +0 · 1 to go',
    '  Sail a triangle · needs Leave the dock +0 · 2 to go',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 1',
    '  Read the wind · unlocks Leave the dock +0',
    'done 2',
    '  Name the boat parts',
    '  Choose a sailing course',
    'progress 3/8',
  ].join('\n'));
});

test('Board — filter and search intersect the branch; a vanished anchor scopes nothing', () => {
  const tree = learnToSail();

  assert.equal(render(new Board(tree, initialProgress(), { branch: 'wind', search: 'sail', kinds: ['terracotta', 'gold'] })), [
    'locked 1',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 0',
    'done 1',
    '  Choose a sailing course',
    'progress 3/8',
  ].join('\n'));
  const orphaned = new Board(tree, initialProgress(), { branch: 'gone' });
  assert.equal(orphaned.branch, null);
  assert.deepEqual(orphaned.columns.map((column) => column.count), [3, 2, 3]);
});

test('Board — Done folds above twelve to the twelve newest completions, and a step with no date goes last', () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `s${index}`, label: `Step ${index}`, prerequisites: [] }));
  const tree = new SkillTree({ id: 't', title: 'T', nodes });
  const completedAt = Object.fromEntries(nodes.slice(1).map((node, index) => [node.id, 1000 + index]));
  const board = new Board(tree, { completed: new Set(nodes.map((node) => node.id)), completedAt });

  assert.equal(DONE_RECENT_LIMIT, 12);
  assert.deepEqual(board.done.cards.map((card) => card.id), [
    's13', 's12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1', 's0',
  ]);
  const recent = board.recentDone();
  assert.deepEqual({ ids: recent.cards.map((card) => card.id), total: recent.total, folded: recent.folded }, {
    ids: ['s13', 's12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2'],
    total: 14,
    folded: true,
  });
});

test('Board — under Created, Done still folds to its twelve newest completions', () => {
  const nodes = Array.from({ length: 13 }, (_, index) => ({
    id: `s${index}`, label: `Step ${index}`, prerequisites: [], createdMs: 10_000 + index,
  }));
  const tree = new SkillTree({ id: 't', title: 'T', nodes });
  const completedAt = Object.fromEntries(nodes.map((node, index) => [node.id, 1000 + index]));
  const recent = new Board(tree, { completed: new Set(nodes.map((node) => node.id)), completedAt }, { sort: 'oldest' }).recentDone();

  assert.deepEqual({ ids: recent.cards.map((card) => card.id), total: recent.total, folded: recent.folded }, {
    ids: ['s12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1'],
    total: 13,
    folded: true,
  });
});

test('Board — exactly twelve done steps do not fold', () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, label: `Step ${index}`, prerequisites: [] }));
  const tree = new SkillTree({ id: 't', title: 'T', nodes });
  const recent = new Board(tree, { completed: new Set(nodes.map((node) => node.id)), completedAt: {} }).recentDone();

  assert.deepEqual({ count: recent.cards.length, total: recent.total, folded: recent.folded }, { count: 12, total: 12, folded: false });
});

test('Board — shownCards folds only Done, and an expanded Done shows every card newest first', () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `s${index}`, label: `Step ${index}`, prerequisites: index === 13 ? ['s0'] : [] }));
  const tree = new SkillTree({ id: 't', title: 'T', nodes });
  const done = nodes.slice(1, 13).map((node) => node.id).concat('s0');
  const board = new Board(tree, { completed: new Set(done), completedAt: Object.fromEntries(done.map((id, index) => [id, index])) });
  const shown = (name, options) => {
    const { cards, folded, total } = board.shownCards(name, options);
    return `${name} ${cards.map((card) => card.id).join(' ')} · ${total}${folded ? ' · folded' : ''}`;
  };
  assert.deepEqual([shown('done'), shown('done', { doneExpanded: true }), shown('upNext'), shown('locked')], [
    'done s0 s12 s11 s10 s9 s8 s7 s6 s5 s4 s3 s2 · 13 · folded',
    'done s0 s12 s11 s10 s9 s8 s7 s6 s5 s4 s3 s2 s1 · 13',
    'upNext s13 · 1',
    'locked  · 0',
  ]);
});

test('arrivals — a step that became up next or a new unfinished step arrives; a reset, a completion and a new done step stay quiet', () => {
  const tree = learnToSail();
  const before = new Board(tree, initialProgress());
  const windDone = new Board(tree, { completed: new Set(['course', 'parts', 'rig', 'wind']), completedAt: {} });
  assert.deepEqual([...arrivals(before, windDone)], ['dock']);
  assert.deepEqual([...arrivals(windDone, before)], []);

  const grown = learnToSail([
    { id: 'reef', label: 'Reefing basics', prerequisites: ['wind'] },
    { id: 'knot', label: 'Figure eight', prerequisites: [] },
    { id: 'logged', label: 'Logged trip', prerequisites: [] },
  ]);
  const after = new Board(grown, { completed: new Set(['course', 'parts', 'rig', 'logged']), completedAt: {} });
  assert.deepEqual([...arrivals(before, after)], ['reef', 'knot']);
});

test('arrivals — a Board that shares no step with the one before is a roadmap arriving whole, so nothing wakes', () => {
  const empty = new Board(new SkillTree({ id: 'empty', title: 'Empty', nodes: [] }), { completed: new Set(), completedAt: {} });
  const other = new Board(new SkillTree({ id: 'other', title: 'Other', nodes: [{ id: 'x', label: 'X', prerequisites: [] }] }), { completed: new Set(), completedAt: {} });
  assert.deepEqual([...arrivals(empty, new Board(learnToSail(), initialProgress()))], []);
  assert.deepEqual([...arrivals(other, new Board(learnToSail(), initialProgress()))], []);
});

test('Board — Created sorts Locked and Up next, newest or oldest, ties in authored order; Done stays newest completed', () => {
  const tree = learnToSail();

  assert.equal(render(new Board(tree, initialProgress(), { sort: 'newest' })), [
    'locked 3',
    '  Leave the dock · needs Read the wind +0 · 1 to go',
    '  Sail a triangle · needs Leave the dock +0 · 2 to go',
    '  Sail solo · needs Sail a triangle +1 · 4 to go',
    'upNext 2',
    '  Tie a bowline',
    '  Read the wind · unlocks Leave the dock +0',
    'done 3',
    '  Rig the boat',
    '  Name the boat parts',
    '  Choose a sailing course',
    'progress 3/8',
  ].join('\n'));
  assert.deepEqual(new Board(tree, initialProgress(), { sort: 'oldest' }).upNext.cards.map((card) => card.id), ['wind', 'bowline']);
  assert.deepEqual(BOARD_SORTS, ['roadmap', 'newest', 'oldest']);
});

test('Board — an unknown creation date sorts last in both directions, ties in authored order', () => {
  const tree = new SkillTree({ id: 't', title: 'T', nodes: [
    { id: 'undated', label: 'Undated', prerequisites: [] },
    { id: 'unknown', label: 'Unknown', prerequisites: [], createdMs: null },
    { id: 'old', label: 'Old', prerequisites: [], createdMs: 5000 },
    { id: 'later', label: 'Later', prerequisites: [], createdMs: 7000 },
    { id: 'twin', label: 'Twin', prerequisites: [], createdMs: 7000 },
    { id: 'new', label: 'New', prerequisites: [], createdMs: 9000 },
  ] });
  const none = { completed: new Set(), completedAt: {} };

  assert.deepEqual(new Board(tree, none, { sort: 'newest' }).upNext.cards.map((card) => card.id), ['new', 'later', 'twin', 'old', 'undated', 'unknown']);
  assert.deepEqual(new Board(tree, none, { sort: 'oldest' }).upNext.cards.map((card) => card.id), ['old', 'later', 'twin', 'new', 'undated', 'unknown']);
});

test('Board — an unknown sort is refused, and columnOf reads the whole roadmap whatever is shown', () => {
  const tree = learnToSail();
  const board = new Board(tree, initialProgress(), { kinds: ['gold'] });

  assert.throws(() => new Board(tree, initialProgress(), { sort: 'unlocked' }), { message: 'Unknown board sort "unlocked"' });
  assert.deepEqual(['course', 'wind', 'dock', 'gone'].map((id) => board.columnOf(id)), ['done', 'upNext', 'locked', null]);
});

// A query as one line: what narrows it, the way out an emptied column names, and the order in force.
function describe(query) {
  return `sort ${query.sort} · kinds [${query.kinds.join(', ')}] · search "${query.search}" · branch ${query.branch} · recovery ${query.recovery}`;
}

test('BoardQuery — each change returns a new query; clearing filters takes the kinds and the search and leaves the branch', () => {
  const start = new BoardQuery();
  const narrowed = start.sortedBy('newest').toggledKind('sky').toggledKind('gold').searchingFor(' wind').inBranch('wind');

  assert.deepEqual([start, narrowed.toggledKind('sky'), narrowed, narrowed.without('search'), narrowed.without('kinds'),
    narrowed.without('both'), narrowed.without('sort'), narrowed.without('branch'), start.inBranch('wind')].map(describe), [
    'sort roadmap · kinds [] · search "" · branch null · recovery null',
    'sort newest · kinds [gold] · search " wind" · branch wind · recovery both',
    'sort newest · kinds [sky, gold] · search " wind" · branch wind · recovery both',
    'sort newest · kinds [sky, gold] · search "" · branch wind · recovery kinds',
    'sort newest · kinds [] · search " wind" · branch wind · recovery search',
    'sort newest · kinds [] · search "" · branch wind · recovery null',
    'sort roadmap · kinds [sky, gold] · search " wind" · branch wind · recovery both',
    'sort newest · kinds [sky, gold] · search " wind" · branch null · recovery both',
    'sort roadmap · kinds [] · search "" · branch wind · recovery null',
  ]);
  assert.equal(start.searchingFor('   ').recovery, null);
  assert.ok(Object.isFrozen(narrowed));
  assert.throws(() => start.sortedBy('unlocked'), /Unknown board sort "unlocked"/);
  assert.throws(() => start.without('everything'), /Unknown board query part "everything"/);
});

test('BoardQuery — kinds narrow only among the hues a filter offers, so a kind with no control left hides nothing', () => {
  const query = new BoardQuery({ kinds: ['sky', 'plum'] });

  assert.equal(query.among(['sky', 'plum', 'gold']), query);
  assert.deepEqual(query.among(['sky', 'gold']).kinds, ['sky']);
  assert.deepEqual(query.among([]).kinds, []);
});

test('Board — a query builds the Board: Created · newest orders Locked and Up next, Done keeps its newest completions', () => {
  assert.equal(render(new Board(learnToSail(), initialProgress(), new BoardQuery().sortedBy('newest').toggledKind('sky').toggledKind('olive'))), [
    'locked 1',
    '  Sail a triangle · needs Leave the dock +0 · 2 to go',
    'upNext 2',
    '  Tie a bowline',
    '  Read the wind · unlocks Leave the dock +0',
    'done 1',
    '  Name the boat parts',
    'progress 3/8',
  ].join('\n'));
});
