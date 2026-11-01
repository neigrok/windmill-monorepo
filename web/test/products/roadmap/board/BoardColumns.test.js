import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { BoardColumns, columnStage, swapRail, enterAtUpNext } = await import('../../../../src/products/roadmap/board/BoardColumns.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');
const { Board } = await import('../../../../src/products/roadmap/board/Board.js');

function learnToSail({ extraDone = 0 } = {}) {
  const knots = Array.from({ length: extraDone }, (_, index) => ({
    id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: [], color: 'plum', description: '',
  }));
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta', description: '' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky', description: '' },
    { id: 'rig', label: 'Rig the boat', prerequisites: ['parts'], color: 'terracotta', description: '' },
    { id: 'bowline', label: 'Tie a bowline', prerequisites: ['parts'], color: 'olive', description: '' },
    { id: 'wind', label: 'Read the wind', prerequisites: ['parts'], color: 'sky', description: '' },
    { id: 'dock', label: 'Leave the dock', prerequisites: ['rig', 'wind'], color: 'terracotta', description: '' },
    { id: 'triangle', label: 'Sail a triangle', prerequisites: ['dock'], color: 'olive', description: '' },
    { id: 'solo', label: 'Sail solo', prerequisites: ['triangle', 'bowline'], color: 'gold', description: '' },
    ...knots,
  ] });
  const completed = new Set(['course', 'parts', 'rig', ...knots.map((knot) => knot.id)]);
  const completedAt = { course: 100, parts: 200, rig: 300, ...Object.fromEntries(knots.map((knot, index) => [knot.id, 400 + index])) };
  return new Board(tree, { completed, completedAt });
}

// One line per landmark the reader meets, in document order.
function outline(props) {
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { selectedId: null, onSelect: () => {}, doneExpanded: false, onToggleDone: () => {}, ...props }));
  const landmarks = /<section class="st-board-columns-(column|rail) st-board-columns-\w+--(\w+)"|<h2 [^>]*aria-label="([^"]+)"|st-board-card-title">([^<]+)|st-board-columns-deck-layer--behind-(\d)"><span class="st-board-columns-deck-card" style="--st-board-rail:var\(--kind-(\w+)\)">|st-board-columns-deck-title">([^<]+)|st-board-show-all">([^<]+)|<\/svg>(Show)<\/button>/g;
  return [...html.matchAll(landmarks)].map(([, shape, column, heading, card, behind, kind, front, showAll, show]) => {
    if (shape) return `${shape} ${column}`;
    if (heading) return `  heading ${heading}`;
    if (card) return `  card ${card}`;
    if (behind) return `  deck ${behind} behind · ${kind}`;
    if (front) return `    front ${front}`;
    if (showAll) return `  ${showAll}`;
    return `  button ${show}`;
  });
}

test('columnStage — from 1024px every column stands; below it Done folds to a rail and Up next never does', () => {
  assert.deepEqual(columnStage({ band: 'desktop', railed: 'locked' }), { locked: 'full', upNext: 'full', done: 'full' });
  assert.deepEqual(columnStage({ band: 'tablet' }), { locked: 'full', upNext: 'full', done: 'rail' });
  assert.deepEqual(columnStage({ band: 'tablet', railed: 'locked' }), { locked: 'rail', upNext: 'full', done: 'full' });
});

test('swapRail — Show on a rail stands that column and folds the other side column instead', () => {
  assert.equal(swapRail('done'), 'locked');
  assert.equal(swapRail('locked'), 'done');
});

test('BoardColumns — at 1024px and up Locked, Up next and Done stand in flow order, each heading naming its count', () => {
  assert.deepEqual(outline({ board: learnToSail(), band: 'desktop' }), [
    'column locked',
    '  heading Locked, 3 steps',
    '  card Leave the dock',
    '  card Sail a triangle',
    '  card Sail solo',
    'column upNext',
    '  heading Up next, 2 steps',
    '  card Read the wind',
    '  card Tie a bowline',
    'column done',
    '  heading Done, 3 steps',
    '  card Rig the boat',
    '  card Name the boat parts',
    '  card Choose a sailing course',
  ]);
});

test('BoardColumns — on a tablet Done is a rail: its count, the newest completion in front of the next two, and Show', () => {
  assert.deepEqual(outline({ board: learnToSail(), band: 'tablet' }), [
    'column locked',
    '  heading Locked, 3 steps',
    '  card Leave the dock',
    '  card Sail a triangle',
    '  card Sail solo',
    'column upNext',
    '  heading Up next, 2 steps',
    '  card Read the wind',
    '  card Tie a bowline',
    'rail done',
    '  heading Done, 3 steps',
    '  deck 2 behind · terracotta',
    '  deck 1 behind · sky',
    '  deck 0 behind · terracotta',
    '    front Rig the boat',
    '  button Show',
  ]);
});

test('BoardColumns — the Up next weighting: an accent dot and a filled count only on its heading, a tinted ground by class', () => {
  const html = renderToStaticMarkup(React.createElement(BoardColumns, { board: learnToSail(), band: 'desktop', onSelect: () => {}, onToggleDone: () => {} }));
  const headings = [...html.matchAll(/<h2 class="([^"]+)" aria-label="[^"]+">(.*?)<\/h2>/g)].map(([, className, inner]) => `${className.trim()} · ${inner}`);
  assert.deepEqual(headings, [
    'st-board-columns-heading st-board-columns-heading--locked · <span class="st-board-columns-title">Locked</span><span class="st-board-columns-count">3</span>',
    'st-board-columns-heading st-board-columns-heading--upNext · <span class="st-board-columns-accent" aria-hidden="true"></span><span class="st-board-columns-title">Up next</span><span class="st-board-columns-count">2</span>',
    'st-board-columns-heading st-board-columns-heading--done · <span class="st-board-columns-title">Done</span><span class="st-board-columns-count">3</span>',
  ]);
});

test('BoardColumns — a Done column past twelve shows its twelve newest and a Show all row until expanded', () => {
  const board = learnToSail({ extraDone: 10 });
  const doneLines = (doneExpanded) => {
    const lines = outline({ board, band: 'desktop', doneExpanded });
    return lines.slice(lines.indexOf('column done'));
  };
  const newestTwelve = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `  card Knot ${n}`).concat(['  card Rig the boat', '  card Name the boat parts']);
  assert.deepEqual(doneLines(false), ['column done', '  heading Done, 13 steps', ...newestTwelve, '  Show all 13']);
  assert.deepEqual(doneLines(true), ['column done', '  heading Done, 13 steps', ...newestTwelve, '  card Choose a sailing course']);
});

test('BoardColumns — a rail over fewer than three cards stacks only what it has', () => {
  const board = learnToSail();
  board.done.cards = board.done.cards.slice(0, 1);
  const lines = outline({ board, band: 'tablet' });
  assert.deepEqual(lines.slice(lines.indexOf('rail done')), ['rail done', '  heading Done, 1 step', '  deck 0 behind · terracotta', '    front Rig the boat', '  button Show']);
});

function focusArrival({ fromInside = false, keyboard = true, onFirstUpNext = false, upNextEmpty = false } = {}) {
  const moves = [];
  const firstUpNext = { focus: () => moves.push('first Up next') };
  const previous = { name: 'previous' };
  const target = onFirstUpNext ? firstUpNext : { focus: () => moves.push('target') };
  target.matches = (selector) => selector === '.st-board-card:focus-visible' && keyboard;
  enterAtUpNext({
    relatedTarget: previous,
    target,
    currentTarget: {
      contains: (node) => fromInside && node === previous,
      querySelector: (selector) => (selector === '.st-board-columns-column--upNext .st-board-card' && !upNextEmpty ? firstUpNext : null),
    },
  });
  return moves;
}

test('enterAtUpNext — keyboard focus arriving on any card from outside lands on the first Up next card', () => {
  assert.deepEqual(focusArrival(), ['first Up next']);
});

test('enterAtUpNext — moves between cards, pointer presses, arriving on Up next itself and an empty Up next stay put', () => {
  assert.deepEqual(focusArrival({ fromInside: true }), []);
  assert.deepEqual(focusArrival({ keyboard: false }), []);
  assert.deepEqual(focusArrival({ onFirstUpNext: true }), []);
  assert.deepEqual(focusArrival({ upNextEmpty: true }), []);
});
