import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: BoardView } = await import('../../../../src/products/roadmap/board/BoardView.jsx');
const { SkillTree } = await import('../../../../src/products/roadmap/model/SkillTree.js');

function render(props, { knots = 0 } = {}) {
  const extra = Array.from({ length: knots }, (_, index) => ({ id: `knot${index + 1}`, label: `Knot ${index + 1}`, prerequisites: [], color: 'plum' }));
  const tree = new SkillTree({ id: 'sail', title: 'Learn to sail', nodes: [
    { id: 'course', label: 'Choose a sailing course', prerequisites: [], color: 'terracotta' },
    { id: 'parts', label: 'Name the boat parts', prerequisites: ['course'], color: 'sky' },
    ...extra,
  ] });
  const html = renderToStaticMarkup(React.createElement(BoardView, {
    tree,
    completed: new Set(['course', ...extra.map((knot) => knot.id)]),
    completedAt: { course: 100, ...Object.fromEntries(extra.map((knot, index) => [knot.id, 200 + index])) },
    selectedId: null,
    onSelect: () => {},
    onSwitchView: () => {},
    ...props,
  }));
  return {
    wrapper: /^<div [^>]+>/.exec(html)[0],
    columns: html.includes('class="st-board-columns"'),
    rails: [...html.matchAll(/st-board-columns-rail--(\w+)/g)].map(([, column]) => column),
    showAll: [...html.matchAll(/st-board-show-all">([^<]+)/g)].map(([, label]) => label),
    selected: [...html.matchAll(/aria-current="true">.*?st-board-card-title">([^<]+)/g)].map(([, label]) => label),
  };
}

test('BoardView — below 744px the phone segments take the columns', () => {
  assert.deepEqual(render({ breakpoint: 'phone' }), {
    wrapper: '<div class="st-board st-board--phone" style="padding-bottom:0">',
    columns: false,
    rails: [],
    showAll: [],
    selected: [],
  });
});

test('BoardView — a tablet stands two columns and folds Done to a rail', () => {
  assert.deepEqual(render({ breakpoint: 'tablet' }), {
    wrapper: '<div class="st-board st-board--columns" style="padding-bottom:0">',
    columns: true,
    rails: ['done'],
    showAll: [],
    selected: [],
  });
});

test('BoardView — under the desktop topbar the columns start a gap below where the bar ends', () => {
  assert.deepEqual(render({ breakpoint: 'desktop', topInset: 90 }), {
    wrapper: '<div class="st-board st-board--columns" style="padding-top:calc(90px + var(--space-3));padding-bottom:0">',
    columns: true,
    rails: [],
    showAll: [],
    selected: [],
  });
});

test('BoardView — shown on a tablet with a Done step selected, Done stands and Locked folds to the rail', () => {
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'course', active: true }).rails, ['locked']);
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'course', active: false }).rails, ['done']);
  assert.deepEqual(render({ breakpoint: 'tablet', selectedId: 'parts', active: true }).rails, ['done']);
});

test('BoardView — shown with a step selected past the Done fold, Done unfolds so its card is there to reveal', () => {
  const folded = render({ breakpoint: 'desktop', selectedId: 'course', active: false }, { knots: 12 });
  assert.deepEqual([folded.showAll, folded.selected], [['Show all 13'], []]);
  const revealed = render({ breakpoint: 'desktop', selectedId: 'course', active: true }, { knots: 12 });
  assert.deepEqual([revealed.showAll, revealed.selected], [[], ['Choose a sailing course']]);
});
