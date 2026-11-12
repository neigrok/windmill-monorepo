import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { StepCard } = await import('../../../../src/products/roadmap/board/StepCard.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { Board } = await import('../../../../src/products/roadmap/board/Board.js');
const { Opening } = await import('../../../../src/products/roadmap/model/Opening.js');

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
  const element = StepCard.type({ card, onSelect: (id) => selected.push(id) });
  element.props.children.props.onClick();
  assert.deepEqual(selected, ['wind']);
});

test('StepCard — a step that just arrived wakes by class, and a card off the roving stop leaves the tab order', () => {
  assert.equal(cardMarkup('dock', { arrived: true, tabIndex: -1 }).split('>')[0],
    '<button type="button" class="st-board-card st-board-card--locked is-arrived" style="--st-board-rail:var(--kind-terracotta)" data-step-id="dock" tabindex="-1"');
});


test('StepCard — phone completion follows the card in DOM order with a named real button; other columns never expose it', () => {
  const html = cardMarkup('wind', { swipe: true, open: true, onSwipe: () => {}, onComplete: () => {} });
  const expectedCard = cardMarkup('wind');
  assert.equal(html, '<div class="st-board-swipe is-open" data-step-id="wind" style="--swipe-offset:104px">' + expectedCard
    + '<button type="button" class="st-board-swipe-complete" tabindex="0" aria-label="Complete Read the wind">'
    + '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4 10-10"></path></svg>'
    + '<span>Complete</span></button></div>');
  assert.equal(cardMarkup('rig', { swipe: true }), cardMarkup('rig'));
  assert.equal(cardMarkup('dock', { swipe: true }), cardMarkup('dock'));
});

// My year, with one step for each thing a tree can have come to; `plan` is done by its mark.
function myYearCards() {
  const opened = (treeId, title, state, done, total, loop = false) => Opening.fromWire({ treeId, title, state, done, total, loop });
  const tree = new SkillTree({ id: 'year', title: 'My year', nodes: [
    { id: 'plan', label: 'Plan the year', prerequisites: [], color: 'gold' },
    { id: 'sail', label: 'Learn to sail', prerequisites: ['plan'], color: 'sky', description: 'Feel confident sailing on my own.', opens: 't_sail', opening: opened('t_sail', 'Learn to sail', 'open', 3, 8) },
    { id: 'read', label: 'Read more', prerequisites: ['plan'], color: 'olive', opens: 't_read', opening: opened('t_read', 'Reading list', 'complete', 12, 12) },
    { id: 'coast', label: 'Sail the coast', prerequisites: ['sail'], color: 'sky', opens: 't_coast', opening: opened('t_coast', 'Coast trip', 'open', 0, 5) },
    { id: 'loop', label: 'Learn to sail', prerequisites: ['plan'], color: 'sky', opens: 't_loop', opening: opened('t_loop', 'Learn to sail', 'open', 3, 8, true) },
    { id: 'book', label: 'Write the book', prerequisites: ['plan'], color: 'olive', opens: 't_book', opening: opened('t_book', 'Book draft', 'open', 0, 0) },
    { id: 'bike', label: 'Fix the bike', prerequisites: ['plan'], color: 'terracotta', opens: 't_gone', opening: Opening.fromWire({ treeId: 't_gone', missing: true }) },
    { id: 'late', label: 'Run a 10K', prerequisites: ['plan'], color: 'terracotta', opens: 't_late', opening: Opening.unread('t_late') },
  ] });
  const board = new Board(tree, { completed: new Set(['plan']), completedAt: { plan: 1 } });
  return new Map(board.columns.flatMap((column) => column.cards).map((card) => [card.id, card]));
}

const pillOf = (id, props = {}) => {
  const html = renderToStaticMarkup(React.createElement(StepCard, { card: myYearCards().get(id), onSelect: () => {}, ...props }));
  const pill = /<span class="st-board-tree-pill[^"]*">.*?<\/span><\/span>(?=<span class="st-board-card-excerpt"|<\/span><\/button>)/.exec(html)?.[0] ?? null;
  return pill && { classes: /class="([^"]*)"/.exec(pill)[1], words: pill.replace(/<svg.*?<\/svg>/g, '').replace(/<[^>]+>/g, ''), column: /st-board-card--(\w+)/.exec(html)[1] };
};

test('StepCard — a step that opens a tree wears its pill: done of total, the tree named only where its title says more, or the one thing in the way', () => {
  const door = { onOpenTree: () => {} };
  assert.deepEqual(['sail', 'read', 'coast', 'loop', 'book', 'bike', 'late', 'plan'].map((id) => pillOf(id, door)), [
    { classes: 'st-board-tree-pill st-board-tree-pill--open st-board-tree-pill--leads', words: '3 of 8', column: 'upNext' },
    { classes: 'st-board-tree-pill st-board-tree-pill--complete st-board-tree-pill--leads', words: 'Reading list · 12 of 12', column: 'done' },
    { classes: 'st-board-tree-pill st-board-tree-pill--open st-board-tree-pill--leads', words: 'Coast trip · 0 of 5', column: 'locked' },
    { classes: 'st-board-tree-pill st-board-tree-pill--loop st-board-tree-pill--leads', words: 'Loops back', column: 'upNext' },
    { classes: 'st-board-tree-pill st-board-tree-pill--empty st-board-tree-pill--leads', words: 'Book draft · No steps', column: 'upNext' },
    { classes: 'st-board-tree-pill st-board-tree-pill--missing', words: 'Not found', column: 'upNext' },
    null,
    null,
  ]);
  assert.equal(pillOf('sail').classes, 'st-board-tree-pill st-board-tree-pill--open');
});

test('StepCard — the pill sits between the reason and the excerpt, with the bar only while its tree is under way', () => {
  const html = renderToStaticMarkup(React.createElement(StepCard, { card: myYearCards().get('sail'), onSelect: () => {}, onOpenTree: () => {} }));
  const order = [...html.matchAll(/class="(st-board-card-title|st-board-card-reason|st-board-tree-pill-glyph|st-board-tree-pill-label|st-board-tree-pill-bar|st-board-tree-pill-chevron|st-board-card-excerpt)"/g)].map((match) => match[1]);

  assert.deepEqual(order, ['st-board-card-title', 'st-board-card-reason', 'st-board-tree-pill-glyph', 'st-board-tree-pill-label', 'st-board-tree-pill-bar', 'st-board-tree-pill-chevron', 'st-board-card-excerpt']);
  assert.match(html, /<span class="st-board-tree-pill-bar" aria-hidden="true"><span style="width:37.5%"><\/span><\/span>/);
  assert.equal(renderToStaticMarkup(React.createElement(StepCard, { card: myYearCards().get('read'), onSelect: () => {} })).includes('st-board-tree-pill-bar'), false);
});

test('StepCard — a press on the pill goes into the tree, a press anywhere else opens the step, and a pill with nowhere to go opens the step', () => {
  const presses = (id, onPill, props = {}) => {
    const calls = [];
    const element = StepCard.type({ card: myYearCards().get(id), onSelect: (step) => calls.push(['step', step]), onOpenTree: (step, door) => calls.push(['tree', step, door]), ...props });
    element.props.children.props.onClick({ target: { closest: (selector) => (onPill && selector === '.st-board-tree-pill' ? {} : null) } });
    return calls;
  };

  assert.deepEqual(presses('sail', true), [['tree', 'sail', 'pill']]);
  assert.deepEqual(presses('sail', false), [['step', 'sail']]);
  assert.deepEqual(presses('bike', true), [['step', 'bike']]);
  assert.deepEqual(presses('sail', true, { selecting: true }), [['step', 'sail']]);
  assert.deepEqual(presses('sail', true, { onOpenTree: null }), [['step', 'sail']]);
});

test('StepCard — the swipe of a card that opens a tree reveals Open, never Complete, and none where there is nowhere to go', () => {
  const opened = [];
  const swiped = (id) => renderToStaticMarkup(React.createElement(StepCard, {
    card: myYearCards().get(id), onSelect: () => {}, swipe: true, open: true, onSwipe: () => {}, onComplete: () => {}, onOpenTree: (step, door) => opened.push([step, door]),
  }));
  const action = (html) => /<button type="button" class="st-board-swipe-complete"[^>]*aria-label="([^"]*)">.*<span>([^<]*)<\/span><\/button>/.exec(html)?.slice(1) ?? null;

  assert.deepEqual(['sail', 'loop', 'book', 'late', 'bike', 'coast', 'read'].map((id) => action(swiped(id))), [
    ['Open the tree of Learn to sail', 'Open'],
    ['Open the tree of Learn to sail', 'Open'],
    ['Open the tree of Write the book', 'Open'],
    ['Open the tree of Run a 10K', 'Open'],
    null,
    null,
    null,
  ]);
  const element = StepCard.type({ card: myYearCards().get('sail'), onSelect: () => {}, swipe: true, onSwipe: () => {}, onComplete: () => opened.push(['complete']), onOpenTree: (step, door) => opened.push([step, door]) });
  element.props.reveal.run();
  assert.deepEqual(opened, [['sail', 'swipe']]);
});
