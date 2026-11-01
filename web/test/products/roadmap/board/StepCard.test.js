import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { StepCard } = await import('../../../../src/products/roadmap/board/StepCard.jsx');
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
    '<button type="button" class="st-board-card st-board-card--locked" style="--st-board-rail:var(--kind-terracotta)">',
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
    '<button type="button" class="st-board-card st-board-card--locked" style="--st-board-rail:var(--kind-gold)">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Sail solo</span>',
    '<span class="st-board-card-reason">Needs Sail a triangle +1 · 4 to go</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — an Up next card names the step it opens', () => {
  assert.equal(cardMarkup('wind'), [
    '<button type="button" class="st-board-card st-board-card--upNext" style="--st-board-rail:var(--kind-sky)">',
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
    '<button type="button" class="st-board-card st-board-card--upNext" style="--st-board-rail:var(--kind-olive)">',
    '<span class="st-board-card-rail" aria-hidden="true"></span>',
    '<span class="st-board-card-content">',
    '<span class="st-board-card-title">Tie a bowline</span>',
    '<span class="st-board-card-excerpt">Tie a secure loop that is easy to undo.</span>',
    '</span></button>',
  ].join(''));
});

test('StepCard — a Done card keeps its excerpt, drops the reason line and marks itself when selected', () => {
  assert.equal(cardMarkup('rig', { selected: true }), [
    '<button type="button" class="st-board-card st-board-card--done" style="--st-board-rail:var(--kind-terracotta)" aria-current="true">',
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
