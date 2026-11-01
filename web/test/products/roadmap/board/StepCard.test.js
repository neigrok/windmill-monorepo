import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { StepCard, ColumnCards, CardStack, estimatedHeight } = await import('../../../../src/products/roadmap/board/StepCard.jsx');
const { SHOW_ALL } = await import('../../../../src/products/roadmap/board/traversal.js');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { Board } = await import('../../../../src/products/roadmap/board/Board.js');

function learnToSailBoard() {
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta',
      description: 'Book a beginner course with time on the water.' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky',
      description: 'Identify the mast, boom, hull and rudder.' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta',
      description: 'Set the sails and check the boat before launch.' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive',
      description: 'Tie a secure loop that is easy to undo.' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky',
      description: 'Learn to spot shifts in wind direction.' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta',
      description: 'Cast off safely and steer clear of the dock.' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive',
      description: 'Practise reaching, tacking and returning to start.' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', description: '' },
  ] });
  return new Board(tree, { completed: new Set(['course', 'parts', 'rig']), completedAt: { course: 100, parts: 200, rig: 300 } });
}

function cardMarkup(id, props = {}) {
  const card = learnToSailBoard().columns.flatMap((column) => column.cards).find((candidate) => candidate.id === id);
  return renderToStaticMarkup(React.createElement(StepCard, { card, onSelect: () => {}, ...props }));
}

test('StepCard — a Locked card sits at the dimmed tier and names what it needs and how many steps are left', () => {
  assert.equal(cardMarkup('dock'), [
    '<button type="button" class="st-board-card st-board-card--locked" style="--st-board-rail:var(--kind-terracotta)" data-step-id="dock" tabindex="0">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Leave the dock</span>',
    '<span class="st-board-card-reason">Needs Read the wind · 1 to go</span>',
    '<span class="st-board-card-excerpt">Cast off safely and steer clear of the dock.</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — several missing prerequisites name the first and count the rest; no description means no excerpt', () => {
  assert.equal(cardMarkup('solo'), [
    '<button type="button" class="st-board-card st-board-card--locked" style="--st-board-rail:var(--kind-gold)" data-step-id="solo" tabindex="0">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Sail solo</span>',
    '<span class="st-board-card-reason">Needs Sail a triangle +1 · 4 to go</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — an Up next card names the step it opens', () => {
  assert.equal(cardMarkup('wind'), [
    '<button type="button" class="st-board-card st-board-card--upNext" style="--st-board-rail:var(--kind-sky)" data-step-id="wind" tabindex="0">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Read the wind</span>',
    '<span class="st-board-card-reason">Unlocks Leave the dock</span>',
    '<span class="st-board-card-excerpt">Learn to spot shifts in wind direction.</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — an Up next card that opens nothing has no reason line', () => {
  assert.equal(cardMarkup('bowline'), [
    '<button type="button" class="st-board-card st-board-card--upNext" style="--st-board-rail:var(--kind-olive)" data-step-id="bowline" tabindex="0">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Tie a bowline</span>',
    '<span class="st-board-card-excerpt">Tie a secure loop that is easy to undo.</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — a Done card keeps its excerpt, drops the reason line and marks itself when selected', () => {
  assert.equal(cardMarkup('rig', { selected: true }), [
    '<button type="button" class="st-board-card st-board-card--done" style="--st-board-rail:var(--kind-terracotta)" data-step-id="rig" tabindex="0" aria-current="true">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Rig the boat</span>',
    '<span class="st-board-card-excerpt">Set the sails and check the boat before launch.</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — a click selects the card’s step', () => {
  const selected = [];
  const card = learnToSailBoard().upNext.cards[0];
  const element = StepCard({ card, onSelect: (id) => selected.push(id) });
  element.props.onClick();
  assert.deepEqual(selected, ['wind']);
});

test('StepCard — a step that just arrived wakes by class, and a card off the roving stop leaves the tab order', () => {
  assert.equal(cardMarkup('dock', { arrived: true, tabIndex: -1 }).split('>')[0],
    '<button type="button" class="st-board-card st-board-card--locked is-arrived" style="--st-board-rail:var(--kind-terracotta)" data-step-id="dock" tabindex="-1"');
});

test('estimatedHeight — an unmeasured card counts its frame, a title line, and a line each for its reason and excerpt', () => {
  const board = learnToSailBoard();
  const byId = new Map(board.columns.flatMap((column) => column.cards).map((card) => [card.id, card]));
  assert.deepEqual(['dock', 'solo', 'bowline', 'rig'].map((id) => estimatedHeight(byId.get(id))), [96, 72, 74, 74]);
});

test('CardStack — the range holds every card any part of which lies in view, the gap counted between cards', () => {
  const stack = new CardStack([100, 50, 100, 50, 100], 10);
  assert.deepEqual(stack.offsets, [0, 110, 170, 280, 340]);
  assert.deepEqual(stack.rangeIn(-40, 100), { first: 0, last: 0 });
  assert.deepEqual(stack.rangeIn(105, 200), { first: 1, last: 2 });
  assert.deepEqual(stack.rangeIn(1000, 1200), { first: 4, last: 4 });
  assert.deepEqual(new CardStack([], 10).rangeIn(0, 500), { first: 0, last: -1 });
});

test('CardStack — the window widens the range by the overscan, keeps each pinned card and spans every skipped stretch with one spacer', () => {
  const stack = new CardStack(Array.from({ length: 40 }, () => 80), 8);
  assert.deepEqual(stack.window({ first: 20, last: 22 }, 2, [0, 39]), [
    0, { spacer: 17 * 88 - 8, from: 1 }, 18, 19, 20, 21, 22, 23, 24, { spacer: 14 * 88 - 8, from: 25 }, 39,
  ]);
  assert.deepEqual(stack.window({ first: 0, last: 3 }, 10, []), [...Array.from({ length: 14 }, (_, index) => index), { spacer: 26 * 88 - 8, from: 14 }]);
  assert.deepEqual(stack.window({ first: 0, last: 1 }, 1, [7, -1, 40]), [0, 1, 2, { spacer: 4 * 88 - 8, from: 3 }, 7, { spacer: 32 * 88 - 8, from: 8 }]);
});

function knotsDone(count) {
  const tree = new SkillTree({ id: 'knots', title: 'Knots', nodes: Array.from({ length: count }, (_, index) => ({
    id: `knot${index}`, label: `Knot ${index}`, prerequisites: [], color: 'plum',
  })) });
  return new Board(tree, { completed: new Set(tree.nodes.map((node) => node.id)), completedAt: Object.fromEntries(tree.nodes.map((node, index) => [node.id, index])) });
}

function runMarkup(board, props) {
  return renderToStaticMarkup(React.createElement(ColumnCards, { onSelect: () => {}, onExpandDone: () => {}, ...props }))
    .replace(/<span class="st-board-card-rail"[^]*?<\/button>/g, '</button>')
    .replace(/<svg[^]*?<\/svg>/g, '<svg/>');
}

test('ColumnCards — a folded Done paints its twelve newest, then the Show all row, which holds the roving stop', () => {
  const board = knotsDone(14);
  const card = (n, tabIndex = -1) => `<button type="button" class="st-board-card st-board-card--done" style="--st-board-rail:var(--kind-plum)" data-step-id="knot${n}" tabindex="${tabIndex}"></button>`;
  assert.equal(runMarkup(board, { shown: board.shownCards('done'), stopId: SHOW_ALL }), [
    '<div class="st-board-cards">',
    ...[13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((n) => card(n)),
    '</div>',
    '<button type="button" tabindex="0" class="st-board-show-all">Show all 14<svg/></button>',
  ].join(''));
});

test('ColumnCards — a long column first paints the top of its run, the selected and pinned cards, and spacers for the rest', () => {
  const board = knotsDone(200);
  const html = runMarkup(board, { shown: board.shownCards('done', { doneExpanded: true }), stopId: 'knot150', pinned: ['knot150'], selectedId: 'knot0' });
  const rendered = [...html.matchAll(/data-step-id="knot(\d+)" tabindex="(-1|0)"|st-board-cards-spacer" style="height:(\d+)px"/g)]
    .map(([, n, tabIndex, spacer]) => (spacer ? `spacer ${spacer}` : `${n}${tabIndex === '0' ? ' stop' : ''}`));
  assert.deepEqual(rendered, [
    ...Array.from({ length: 26 }, (_, index) => String(199 - index)),
    'spacer 1150', '150 stop', 'spacer 7450', '0',
  ]);
});
