import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ViewSwitch } = await import('../../../../src/products/roadmap/identity/ViewSwitch.jsx');

function options(props) {
  const html = renderToStaticMarkup(React.createElement(ViewSwitch, { onSwitch: () => {}, ...props }));
  const group = /<div class="([^"]+)" role="group" aria-label="([^"]+)">/.exec(html);
  const buttons = [...html.matchAll(/<button [^>]*aria-label="([^"]+)" aria-pressed="(true|false)"/g)].map((match) => `${match[1]} ${match[2]}`);
  return [`${group[1]} · ${group[2]}`, ...buttons];
}

test('ViewSwitch — a two-option group named View, the active view pressed, on both bands', () => {
  assert.deepEqual(options({ view: 'board', phone: true }), ['st-board-switch st-board-switch--phone · View', 'Board true', 'Graph false']);
  assert.deepEqual(options({ view: 'tree' }), ['st-board-switch st-board-switch--wide · View', 'Board false', 'Graph true']);
});

test('ViewSwitch — choosing the other view switches; choosing the active one does nothing', () => {
  const chosen = [];
  const group = ViewSwitch({ view: 'board', phone: true, onSwitch: (view) => chosen.push(view) });
  const [board, graph] = group.props.children;
  board.props.onClick();
  graph.props.onClick();
  assert.deepEqual(chosen, ['tree']);
});

test('ViewSwitch — every band wears one pair of glyphs (01.02): Board three outlined columns, Graph the branching tree, stroked 1.66667 with round caps and joins', () => {
  const svg = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.66667" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const expected = [
    `${svg}<rect x="2.5" y="3.33333" width="3.5" height="13.33333" rx="1"></rect><rect x="8.25" y="3.33333" width="3.5" height="9.16667" rx="1"></rect><rect x="14" y="3.33333" width="3.5" height="11.66667" rx="1"></rect></svg>`,
    `${svg}<circle cx="10" cy="4.16667" r="2.08333"></circle><circle cx="5" cy="15.8333" r="2.08333"></circle><circle cx="15" cy="15.8333" r="2.08333"></circle><path d="M10 6.25V9.58333M10 9.58333L5.83333 14.1667M10 9.58333L14.1667 14.1667"></path></svg>`,
  ];
  const glyphs = (props) => [...renderToStaticMarkup(React.createElement(ViewSwitch, { view: 'board', onSwitch: () => {}, ...props })).matchAll(/<svg.*?<\/svg>/g)].map(([glyph]) => glyph);
  assert.deepEqual(glyphs({ phone: true }), expected);
  assert.deepEqual(glyphs({}), expected);
});
