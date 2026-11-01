import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ViewSwitch } = await import('../../../../src/products/roadmap/board/ViewSwitch.jsx');

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
